/**
 * Integration tests for the direct Claude SDK/query surface.
 *
 * Covers:
 *   - clarification + multi-turn context via resume
 *   - real model switching across resumed turns
 *   - Idle MCP tool usage (`mcp__idle__change_title`)
 *   - native Claude tool usage against the copied fixture project
 *   - real in-project native file-tool execution
 *   - permission denial and interrupt handling
 *
 * Notes:
 *   - This is the real current Claude surface we own directly.
 *   - It calls query() directly and therefore does not exercise the process
 *     sandbox installed by claudeRemote(). It covers the SDK's independent
 *     tool allow/deny and pending-tool interruption controls.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { getIntegrationEnv } from '@/testing/currentIntegrationEnv';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query, type QueryOptions, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKSystemMessage } from './sdk';
import { startIdleServer } from './utils/startIdleServer';
import { createIdleMcpBridgeConfig } from './utils/createIdleMcpBridgeConfig';
import { systemPrompt } from './utils/systemPrompt';
import { shouldRunLiveAgentIntegration } from '@/testing/liveAgentIntegration';
import { getProjectPath } from './utils/path';

// Stable aliases deliberately track the newest model available to the
// authenticated Claude Code installation instead of expiring dated IDs.
const MODEL_OPUS = 'opus';
const MODEL_SONNET = 'sonnet';
const integrationEnv = getIntegrationEnv();
const claudeHistoryDir = getProjectPath(integrationEnv.projectPath);
const deniedFile = join(integrationEnv.projectPath, 'claude-denied-write.txt');
const interruptedFile = join(integrationEnv.projectPath, 'claude-interrupted-write.txt');
const liveTaskFile = join(integrationEnv.projectPath, 'claude-live-task.txt');

function cleanupTestArtifacts() {
    rmSync(deniedFile, { force: true });
    rmSync(interruptedFile, { force: true });
    rmSync(liveTaskFile, { force: true });
    rmSync(claudeHistoryDir, { force: true, recursive: true });
}

function inputRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') {
        return input as Record<string, unknown>;
    }

    return {};
}

function assistantText(messages: SDKMessage[]): string {
    return messages
        .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
        .flatMap((message) => {
            return message.message.content
                .filter((block) => block.type === 'text' || block.type === 'thinking')
                .map((block) => block.type === 'text' ? block.text ?? '' : String(block.thinking ?? ''));
        })
        .join('\n');
}

function toolUseNames(messages: SDKMessage[]): string[] {
    return assistantToolUses(messages).map((toolUse) => toolUse.name);
}

function assistantToolUses(messages: SDKMessage[]): Array<{ input: unknown; name: string }> {
    return messages
        .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
        .flatMap((message) => {
            return message.message.content
                .filter((block) => block.type === 'tool_use')
                .map((block) => ({
                    input: block.input,
                    name: block.name ?? '',
                }));
        })
        .filter((toolUse) => Boolean(toolUse.name));
}

function initMessage(messages: SDKMessage[]): SDKSystemMessage | undefined {
    return messages.find((message): message is SDKSystemMessage => {
        return message.type === 'system' && message.subtype === 'init';
    });
}

function resultMessage(messages: SDKMessage[]): SDKResultMessage | undefined {
    return messages.find((message): message is SDKResultMessage => message.type === 'result');
}

function resultText(messages: SDKMessage[]): string | undefined {
    const msg = resultMessage(messages);
    return msg && 'result' in msg ? msg.result : undefined;
}

function sessionIdFrom(messages: SDKMessage[]): string {
    const result = resultMessage(messages)?.session_id;
    if (result) {
        return result;
    }

    const init = initMessage(messages)?.session_id;
    if (init) {
        return init;
    }

    throw new Error('No Claude session ID found in messages');
}

async function collectMessages(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const messages: SDKMessage[] = [];
    for await (const message of iterable) {
        messages.push(message);
    }
    return messages;
}

async function isClaudeQueryAvailable(): Promise<boolean> {
    try {
        const messages = await collectMessages(query({
            prompt: 'Say exactly ready',
            options: {
                abort: AbortSignal.timeout(20_000),
                cwd: integrationEnv.projectPath,
                model: MODEL_SONNET,
                persistSession: false,
            },
        }));

        const result = resultMessage(messages);
        const available = (result && 'result' in result) ? result.result?.trim() === 'ready' : false;
        if (!available) {
            console.log('[claude-test] Claude query probe did not return the expected response');
        }
        return available;
    } catch {
        console.log('[claude-test] Skipping: Claude query unavailable');
        return false;
    }
}

type ClaudeTurn = {
    assistantText: string;
    init?: SDKSystemMessage;
    messages: SDKMessage[];
    result?: SDKResultMessage;
    sessionId: string;
    toolUseNames: string[];
};

class ClaudeQueryDriver {
    private idleServer: Awaited<ReturnType<typeof startIdleServer>> | null = null;
    private titleSummaries: string[] = [];

    async start(): Promise<void> {
        const fakeSessionClient = {
            sessionId: 'claude-integration-test',
            updateMetadata: async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                const updated = updater({});
                const summary = updated.summary as { text?: string } | undefined;
                if (summary?.text) this.titleSummaries.push(summary.text);
            },
        } as unknown as ApiSessionClient;

        this.idleServer = await startIdleServer(fakeSessionClient);
    }

    stop(): void {
        this.idleServer?.stop();
        this.idleServer = null;
    }

    getTitleSummaries(): string[] {
        return [...this.titleSummaries];
    }

    buildOptions(options: {
        allowedTools: string[];
        canCallTool?: QueryOptions['canCallTool'];
        disallowedTools?: string[];
        model: string;
        resume?: string;
    }): QueryOptions {
        if (!this.idleServer) {
            throw new Error('ClaudeQueryDriver.start() must be called first');
        }

        return {
            appendSystemPrompt: systemPrompt,
            canCallTool: options.canCallTool ?? (async (_toolName, input) => {
                return {
                    behavior: 'allow',
                    updatedInput: inputRecord(input),
                };
            }),
            cwd: integrationEnv.projectPath,
            disallowedTools: options.disallowedTools,
            mcpServers: {
                idle: createIdleMcpBridgeConfig(this.idleServer),
            },
            model: options.model,
            allowedTools: options.allowedTools,
            persistSession: Boolean(options.resume),
            resume: options.resume,
        };
    }

    async runTurn(options: {
        allowedTools: string[];
        canCallTool?: QueryOptions['canCallTool'];
        disallowedTools?: string[];
        model: string;
        prompt: string;
        resume?: string;
    }): Promise<ClaudeTurn> {
        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const run = query({
            prompt: promptStream,
            options: this.buildOptions(options),
        });

        promptStream.push({
            type: 'user',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: options.prompt,
            },
        });
        promptStream.end();

        const messages = await collectMessages(run);
        return {
            assistantText: assistantText(messages),
            init: initMessage(messages),
            messages,
            result: resultMessage(messages),
            sessionId: sessionIdFrom(messages),
            toolUseNames: toolUseNames(messages),
        };
    }
}

const claudeAvailable = shouldRunLiveAgentIntegration() && await isClaudeQueryAvailable();

it('keeps the isolated environment eligible for teardown', () => {
    expect(integrationEnv.projectPath).toBeTruthy();
});

it('requires a working Claude query when live integration is explicitly enabled', () => {
    expect(shouldRunLiveAgentIntegration()).toBe(true);
    expect(claudeAvailable).toBe(true);
});

describe.skipIf(!claudeAvailable)('Claude Integration (SDK/query)', { timeout: 180_000 }, () => {
    let driver: ClaudeQueryDriver | null = null;

    beforeEach(async () => {
        cleanupTestArtifacts();
        driver = new ClaudeQueryDriver();
        await driver.start();
    });

    afterEach(() => {
        driver?.stop();
        driver = null;
        cleanupTestArtifacts();
    });

    it('should clarify, resume across a model switch, use task tools, and edit the project', async () => {
        const clarificationPrompt = new PushableAsyncIterable<SDKMessage>();
        const clarificationMessages: SDKMessage[] = [];
        let answeredClarification = false;

        const clarificationRun = query({
            prompt: clarificationPrompt,
            options: {
                allowedTools: [],
                canCallTool: async (_toolName, input) => {
                    return {
                        behavior: 'allow',
                        updatedInput: inputRecord(input),
                    };
                },
                cwd: integrationEnv.projectPath,
                disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
                model: MODEL_OPUS,
            },
        });

        const clarificationLoop = (async () => {
            for await (const message of clarificationRun) {
                clarificationMessages.push(message);
                const askUserQuestion = assistantToolUses([message]).find((toolUse) => {
                    return toolUse.name === 'AskUserQuestion';
                });
                if (askUserQuestion && !answeredClarification) {
                    answeredClarification = true;
                    clarificationPrompt.push({
                        type: 'user',
                        parent_tool_use_id: null,
                        message: {
                            role: 'user',
                            content: 'I choose OPTION_B.',
                        },
                    });
                    clarificationPrompt.end();
                }
            }
        })();

        clarificationPrompt.push({
            type: 'user',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [
                    'Remember the token ember-orbit-17.',
                    'Use the native AskUserQuestion tool to ask me to choose between OPTION_A and OPTION_B.',
                    'After I answer, reply with exactly ACK-OPTION_B and nothing else.',
                ].join(' '),
            },
        });

        await clarificationLoop;

        const askUserQuestion = assistantToolUses(clarificationMessages).find((toolUse) => {
            return toolUse.name === 'AskUserQuestion';
        });

        expect(initMessage(clarificationMessages)?.model?.toLowerCase()).toContain('opus');
        expect(askUserQuestion).toBeDefined();
        expect(JSON.stringify(askUserQuestion?.input)).toContain('OPTION_A');
        expect(JSON.stringify(askUserQuestion?.input)).toContain('OPTION_B');
        expect(resultText(clarificationMessages)?.trim()).toBe('ACK-OPTION_B');

        const execution = await driver!.runTurn({
            allowedTools: ['mcp__idle__change_title'],
            disallowedTools: ['Bash'],
            model: MODEL_SONNET,
            prompt: [
                'Without me repeating them, use the option I chose earlier and the token you were told to remember earlier.',
                'This is a realistic coding task in the copied lab-rat todo fixture.',
                'Read README.md in the current project first so you are grounded in the real fixture project.',
                'Use the current native task-tracking tool to record exactly these two pending tasks:',
                '1. Implement OPTION_B follow-up',
                '2. Create the in-project live-test artifact',
                'Then create claude-live-task.txt in the current project using native Claude file tools, not Bash.',
                'The file must contain exactly these two lines:',
                'choice=OPTION_B',
                'token=ember-orbit-17',
                'Then update the idle title so it mentions OPTION_B and reply with only DONE.',
            ].join('\n'),
            resume: sessionIdFrom(clarificationMessages),
        });

        const executionToolUses = assistantToolUses(execution.messages);
        const taskToolUses = executionToolUses.filter((toolUse) => {
            return toolUse.name === 'TodoWrite' || toolUse.name === 'TaskCreate';
        });
        expect(execution.init?.model?.toLowerCase()).toContain('sonnet');
        expect(execution.sessionId).toBe(sessionIdFrom(clarificationMessages));
        expect(execution.toolUseNames).toContain('mcp__idle__change_title');
        expect(taskToolUses.length).toBeGreaterThan(0);
        expect(execution.toolUseNames.some((toolName) => ['Write', 'Edit', 'MultiEdit'].includes(toolName))).toBe(true);
        expect(execution.toolUseNames).not.toContain('Bash');
        expect(readFileSync(liveTaskFile, 'utf8').trimEnd()).toBe('choice=OPTION_B\ntoken=ember-orbit-17');
        expect(JSON.stringify(taskToolUses.map((toolUse) => toolUse.input))).toContain('Implement OPTION_B follow-up');
        expect(JSON.stringify(taskToolUses.map((toolUse) => toolUse.input))).toContain('Create the in-project live-test artifact');
        expect(execution.result && 'result' in execution.result ? execution.result.result?.trim() : undefined).toBe('DONE');
    });

    it('should leave the file untouched and explain the refusal when native write is explicitly disallowed', async () => {
        const denied = await driver!.runTurn({
            allowedTools: ['mcp__idle__change_title'],
            disallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
            model: MODEL_SONNET,
            prompt: [
                'Create a file named claude-denied-write.txt in the current working directory using a native Claude file tool, not Bash.',
                'Put exactly DENIED-WRITE in the file.',
                'If you cannot, explain briefly why not.',
            ].join(' '),
        });

        expect(denied.toolUseNames).not.toContain('Bash');
        expect(existsSync(deniedFile)).toBe(false);
        const refusalLanguage = /cannot|can't|unable|not available|not enabled|isn't enabled|disabled|restricted|limitation/;
        expect(denied.assistantText.toLowerCase()).toMatch(refusalLanguage);
        expect(denied.result && 'result' in denied.result ? denied.result.result?.toLowerCase() : undefined).toMatch(refusalLanguage);
    });

    it('should stop a pending AskUserQuestion turn when the caller aborts it', async () => {
        const abortController = new AbortController();
        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const messages: SDKMessage[] = [];
        let abortError: unknown = null;
        const startedAt = Date.now();

        const run = query({
            prompt: promptStream,
            options: {
                abort: abortController.signal,
                allowedTools: [],
                canCallTool: async (_toolName, input) => {
                    return {
                        behavior: 'allow',
                        updatedInput: inputRecord(input),
                    };
                },
                cwd: integrationEnv.projectPath,
                disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
                model: MODEL_SONNET,
                persistSession: false,
            },
        });

        const messagesPromise = (async () => {
            try {
                for await (const message of run) {
                    messages.push(message);
                    if (assistantToolUses([message]).some((toolUse) => toolUse.name === 'AskUserQuestion')) {
                        abortController.abort();
                    }
                }
            } catch (error) {
                abortError = error;
            } finally {
                promptStream.end();
            }
        })();

        promptStream.push({
            type: 'user',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [
                    'Use the native AskUserQuestion tool to ask me to choose between OPTION_A and OPTION_B.',
                    'Do not do anything else after asking.',
                ].join(' '),
            },
        });

        await messagesPromise;

        const terminalResult = resultMessage(messages);
        expect(toolUseNames(messages)).toContain('AskUserQuestion');
        expect(abortController.signal.aborted).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        if (terminalResult) {
            expect(terminalResult.permission_denials.map((denial) => denial.tool_name)).toContain('AskUserQuestion');
            if (abortError !== null) {
                // The SDK can yield its terminal permission-denial result before
                // the child process reports the caller's abort. Both signals are
                // valid as long as the surfaced error is the abort itself.
                expect(abortError).toBeInstanceOf(Error);
                expect((abortError as Error).message).toMatch(/abort/i);
            }
        } else {
            // Some SDK versions terminate the child immediately and surface a
            // process error instead of a graceful permission-denial result.
            expect(abortError).toBeInstanceOf(Error);
        }
        expect(existsSync(interruptedFile)).toBe(false);
    });
});
