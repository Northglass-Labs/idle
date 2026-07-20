import { describe, expect, it, vi } from 'vitest';

import { GeminiPermissionHandler } from './permissionHandler';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

function createSessionMock() {
    let state: Record<string, any> = {};

    return {
        session: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
    };
}

describe('GeminiPermissionHandler', () => {
    it('does not trust a safe-looking ID when the actual tool name is different', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'change_title-1765385846663',
            'shell_command',
            { command: 'rm -rf /' },
        );

        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('uses an exact read-only allowlist in safe-yolo mode', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('safe-yolo');

        await expect(handler.handleToolCall('read-1', 'read_file', { path: 'README.md' }))
            .resolves.toEqual({ decision: 'approved' });

        const pending = handler.handleToolCall('unknown-1', 'deploy_production', {});
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does not auto-approve persistent memory writes in default mode', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);

        const pending = handler.handleToolCall('memory-1', 'save_memory', { text: 'persist me' });
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('keeps explicit yolo mode available', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        handler.setPermissionMode('yolo');

        await expect(handler.handleToolCall('shell-1', 'shell_command', { command: 'pwd' }))
            .resolves.toEqual({ decision: 'approved_for_session' });
    });

    it('does not persist tool names or request identifiers in diagnostics', async () => {
        const { session } = createSessionMock();
        const handler = new GeminiPermissionHandler(session as any);
        const debug = vi.mocked(logger.debug);
        debug.mockClear();

        await handler.handleToolCall(
            'sensitive-title-request-id',
            'mcp__idle__change_title',
            { title: 'Private project title' },
        );
        const pending = handler.handleToolCall(
            'sensitive-command-request-id',
            'private_provider_tool_name',
            { command: 'private command' },
        );
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });

        const output = JSON.stringify(debug.mock.calls);
        expect(output).not.toContain('sensitive-title-request-id');
        expect(output).not.toContain('sensitive-command-request-id');
        expect(output).not.toContain('private_provider_tool_name');
        expect(output).not.toContain('Private project title');
        expect(output).not.toContain('private command');
    });
});
