import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockClaudeRemote,
    mockCleanupStdinAfterInk,
} = vi.hoisted(() => ({
    mockClaudeRemote: vi.fn(),
    mockCleanupStdinAfterInk: vi.fn(async () => {}),
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: mockClaudeRemote,
}));

vi.mock('@/utils/terminalStdinCleanup', () => ({
    cleanupStdinAfterInk: mockCleanupStdinAfterInk,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        handleToolCall = vi.fn();
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponses = vi.fn(() => new Map());
        releaseToolCall = vi.fn();
        isAborted = vi.fn(() => false);
        handleModeChange = vi.fn();
        setPermissionModeUpdater = vi.fn();
    },
}));

import { claudeRemoteLauncher } from './claudeRemoteLauncher';

describe('claudeRemoteLauncher switch RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClaudeRemote.mockImplementation(async (options: { signal: AbortSignal }) => {
            await new Promise<void>((resolve) => {
                if (options.signal.aborted) {
                    resolve();
                    return;
                }
                options.signal.addEventListener('abort', () => resolve(), { once: true });
            });
        });
    });

    it('acknowledges a successful switch RPC with true', async () => {
        let switchHandler: ((params: { to: 'local' }) => Promise<unknown>) | undefined;
        const session = {
            sessionId: 'claude-session-1',
            path: '/tmp/project',
            logPath: '/tmp/idle.log',
            client: {
                sessionId: 'idle-session-1',
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: (params: { to: 'local' }) => Promise<unknown>) => {
                        if (method === 'switch') {
                            switchHandler = handler;
                        }
                    }),
                },
                sendClaudeSessionMessage: vi.fn(),
                closeClaudeSessionTurn: vi.fn(),
                sendSessionEvent: vi.fn(),
                setActiveRequestId: vi.fn(),
                updateMetadata: vi.fn(),
                getMetadata: vi.fn(() => ({})),
            },
            api: {
                push: vi.fn(() => ({ sendSessionNotification: vi.fn() })),
            },
            queue: {
                waitForMessagesAndGetAsString: vi.fn(),
                size: vi.fn(() => 0),
            },
            onAbort: vi.fn(),
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            clearSessionId: vi.fn(),
            consumeOneTimeFlags: vi.fn(),
            claudeEnvVars: undefined,
            claudeArgs: undefined,
            mcpServers: {},
            allowedTools: [],
            hookSettingsPath: '/tmp/hook-settings.json',
            jsRuntime: 'node',
            sandboxConfig: undefined,
        };

        const launcher = claudeRemoteLauncher(session as any);
        await vi.waitFor(() => {
            expect(switchHandler).toBeDefined();
            expect(mockClaudeRemote).toHaveBeenCalledOnce();
        });

        await expect(switchHandler!({ to: 'local' })).resolves.toBe(true);
        await expect(launcher).resolves.toBe('switch');
        expect(mockCleanupStdinAfterInk).toHaveBeenCalledOnce();
    });
});
