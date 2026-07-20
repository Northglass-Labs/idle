import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, prepareSandboxedSpawn } from '@/sandbox/manager';
import { spawn } from 'node:child_process';
import { getToolDescriptor } from './utils/getToolDescriptor';

function canPreApproveTool(toolName: string): boolean {
    return toolName !== 'AskUserQuestion' && !getToolDescriptor(toolName).exitPlan;
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal; toolUseID: string }) => Promise<PermissionResult>,
    /** Called when the Query object is ready — allows permission handler to call setPermissionMode */
    onQueryReady?: (query: { setPermissionMode: (mode: string) => Promise<void> }) => void,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,
    sandboxConfig?: SandboxConfig,
    onSandboxApplied?: (applied: boolean) => void,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: MessageParam['content'], mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    onSDKMetadata?: (metadata: { tools?: string[]; slashCommands?: string[]; mcpServers?: { name: string; status: string }[]; skills?: string[] }) => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug('[claudeRemote] Found a session ID for --resume');
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Per-session provider configuration flows through the SDK child environment
    // and never mutates the long-lived daemon environment.
    const claudeAdditionalEnv = opts.claudeEnvVars && Object.keys(opts.claudeEnvVars).length > 0
        ? opts.claudeEnvVars
        : undefined;

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands (extract text for parsing when content is a block array)
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : (initial.message.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
    const specialCommand = parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        opts.onReady();
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const requestedAllowedTools = initial.mode.allowedTools
        ? initial.mode.allowedTools.concat(opts.allowedTools)
        : opts.allowedTools;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        effort: initial.mode.effort,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        // AskUserQuestion and ExitPlanMode always require the live permission
        // callback. A bare SDK allow rule would otherwise shadow canUseTool.
        allowedTools: requestedAllowedTools.filter(canPreApproveTool),
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal; toolUseID: string }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        settingsPath: opts.hookSettingsPath,
        // Per-session secrets land in the spawned child only — never in the daemon's process.env.
        additionalEnv: claudeAdditionalEnv,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    let sandboxCleanup: (() => Promise<void>) | null = null;
    try {
        if (opts.sandboxConfig?.enabled) {
            try {
                if (process.platform === 'win32') {
                    throw new Error(
                        'OS sandboxing is not supported on Windows. Use --no-sandbox explicitly to run Claude remote mode without containment.',
                    );
                }
                sandboxCleanup = await initializeSandbox(opts.sandboxConfig, opts.path);
                const wrapSpawn = await prepareSandboxedSpawn();
                sdkOptions.inheritFullEnvironment = false;
                sdkOptions.spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }) => {
                    const wrapped = wrapSpawn(command, args);
                    return spawn(wrapped.command, wrapped.args, {
                        cwd,
                        env,
                        signal,
                        stdio: ['pipe', 'pipe', 'ignore'],
                        windowsHide: true,
                    });
                };
                opts.onSandboxApplied?.(true);
            } catch (error) {
                opts.onSandboxApplied?.(false);
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`Claude remote sandbox initialization failed: ${reason}`, { cause: error });
            }
        } else {
            opts.onSandboxApplied?.(false);
        }

        // Start the loop only after required containment is ready. query()
        // synchronously invokes the SDK spawn callback.
        const response = query({
            prompt: messages,
            options: sdkOptions,
        });

        // Expose query control methods to permission handler
        if (opts.onQueryReady) {
            opts.onQueryReady({
                setPermissionMode: (permissionMode: string) => response.setPermissionMode(permissionMode as any),
            });
        }

        updateThinking(true);
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debug('[claudeRemote] SDK message received', {
                fieldCount: Object.keys(message).length,
            });

            // Handle messages. During /compact, Claude emits the generated
            // summary as a normal assistant text message before the result.
            // Mark it so downstream UI/protocol mapping can treat it as
            // housekeeping instead of a real assistant response.
            const outboundMessage = isCompactCommand && message.type === 'assistant'
                ? { ...message, isCompactSummary: true } as SDKMessage
                : message;
            opts.onMessage(outboundMessage);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                // Emit SDK metadata (tools, slash commands) from init message
                if (opts.onSDKMetadata) {
                    opts.onSDKMetadata({
                        tools: systemInit.tools,
                        slashCommands: systemInit.slash_commands,
                        mcpServers: systemInit.mcp_servers?.map(s => ({ name: s.name, status: s.status })),
                        skills: systemInit.skills,
                    });
                }

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug('[claudeRemote] Waiting for the session transcript to appear');
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`), 30000);
                    logger.debug('[claudeRemote] Session transcript wait completed', { found });
                    if (!found) {
                        // The transcript never landed on disk within the grace
                        // window. We still register the id so the (now
                        // bounded) scanner watcher can pick it up if it shows
                        // up late and otherwise drops it cleanly instead of
                        // wedging — but surface the anomaly so a stuck remote
                        // launch is visible in the app rather than a silent
                        // "dead instance".
                        logger.debug('[claudeRemote] WARNING: session transcript never appeared after 30s');
                        opts.onCompletionEvent?.('⚠️ Claude session did not produce a transcript — the agent may be unresponsive. Try sending your message again.');
                    }
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                // Wait for next user message without blocking the message loop.
                // Background task messages (task_started, task_progress, task_notification)
                // continue flowing through while we wait for user input.
                opts.nextMessage().then((next) => {
                    if (!next) {
                        messages.end();
                    } else {
                        mode = next.mode;
                        messages.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: next.message } });
                    }
                }).catch(() => {
                    messages.end();
                });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        // Current Claude SDK releases can surface child termination as a
        // generic Error instead of AbortError. The caller's signal is the
        // authoritative cancellation boundary.
        if (e instanceof AbortError || opts.signal?.aborted) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
        if (sandboxCleanup) {
            try {
                await sandboxCleanup();
            } catch {
                logger.warn('[claudeRemote] Failed to reset sandbox after SDK process exit.');
            }
            opts.onSandboxApplied?.(false);
        }
    }
}
