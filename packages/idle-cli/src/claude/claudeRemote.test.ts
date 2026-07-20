import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

const sandboxMocks = vi.hoisted(() => ({
    initializeSandbox: vi.fn(),
    cleanupSandbox: vi.fn(),
    prepareSandboxedSpawn: vi.fn(),
}));

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: sandboxMocks.initializeSandbox,
    prepareSandboxedSpawn: sandboxMocks.prepareSandboxedSpawn,
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
        sandboxMocks.initializeSandbox.mockReset();
        sandboxMocks.cleanupSandbox.mockReset();
        sandboxMocks.prepareSandboxedSpawn.mockReset();
        sandboxMocks.initializeSandbox.mockResolvedValue(sandboxMocks.cleanupSandbox);
        sandboxMocks.prepareSandboxedSpawn.mockResolvedValue(
            (command: string, args: string[]) => ({
                command: 'sh',
                args: ['-c', 'sandbox-template "$0" "$@"', command, ...args],
            }),
        );
    });

    it('requires and cleans up the OS sandbox around the Claude SDK child', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            async *[Symbol.asyncIterator]() {},
        } as any);
        const onSandboxApplied = vi.fn();
        const sandboxConfig = {
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        } as const;

        await claudeRemote({
            sessionId: null,
            path: '/tmp/idle-claude-workspace',
            allowedTools: [],
            hookSettingsPath: '/tmp/idle-test-settings.json',
            sandboxConfig: sandboxConfig as any,
            onSandboxApplied,
            nextMessage: async () => ({ message: 'hello', mode }),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        } as any);

        expect(sandboxMocks.initializeSandbox).toHaveBeenCalledWith(
            sandboxConfig,
            '/tmp/idle-claude-workspace',
        );
        expect(sandboxMocks.prepareSandboxedSpawn).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                inheritFullEnvironment: false,
                spawnClaudeCodeProcess: expect.any(Function),
            }),
        }));
        expect(onSandboxApplied).toHaveBeenCalledWith(true);
        expect(sandboxMocks.cleanupSandbox).toHaveBeenCalledOnce();
    });

    it('never pre-approves interactive question or plan-exit tools', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            async *[Symbol.asyncIterator]() {},
        } as any);

        await claudeRemote({
            sessionId: null,
            path: '/tmp/idle-claude-workspace',
            allowedTools: ['mcp__idle__change_title', 'AskUserQuestion'],
            hookSettingsPath: '/tmp/idle-test-settings.json',
            nextMessage: async () => ({
                message: 'hello',
                mode: {
                    permissionMode: 'default',
                    allowedTools: ['Write', 'AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode'],
                },
            }),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        } as any);

        const allowedTools = vi.mocked(query).mock.calls[0][0].options?.allowedTools;
        expect(allowedTools).toContain('Write');
        expect(allowedTools).toContain('mcp__idle__change_title');
        expect(allowedTools).not.toContain('AskUserQuestion');
        expect(allowedTools).not.toContain('ExitPlanMode');
        expect(allowedTools).not.toContain('exit_plan_mode');
    });

    it('treats a generic SDK process error as cancellation after the caller aborts', async () => {
        const abortController = new AbortController();
        abortController.abort();
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            async *[Symbol.asyncIterator]() {
                throw new Error('Claude process exited after signal');
            },
        } as any);

        await expect(claudeRemote({
            sessionId: null,
            path: '/tmp/idle-claude-workspace',
            allowedTools: [],
            hookSettingsPath: '/tmp/idle-test-settings.json',
            signal: abortController.signal,
            nextMessage: async () => ({ message: 'hello', mode }),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        } as any)).resolves.toBeUndefined();
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/idle-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/idle-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });
});
