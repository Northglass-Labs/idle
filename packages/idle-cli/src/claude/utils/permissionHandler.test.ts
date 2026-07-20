import { describe, expect, it, vi } from 'vitest';

import { PermissionHandler } from './permissionHandler';

vi.mock('@/lib', () => ({
    logger: { debug: vi.fn() },
}));

function createHarness() {
    let state: Record<string, any> = {};
    let permissionRpc: ((message: Record<string, unknown>) => Promise<void>) | undefined;
    const session = {
        api: {
            push: () => ({ sendSessionNotification: vi.fn() }),
        },
        client: {
            sessionId: 'session-1',
            getMetadata: vi.fn(() => ({})),
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
            rpcHandlerManager: {
                registerHandler: vi.fn((_method: string, handler: (message: Record<string, unknown>) => Promise<void>) => {
                    permissionRpc = handler;
                }),
            },
        },
    };
    const handler = new PermissionHandler(session as any);

    return {
        getState: () => state,
        handler,
        permissionRpc: async (message: Record<string, unknown>) => {
            if (!permissionRpc) throw new Error('permission RPC was not registered');
            await permissionRpc(message);
        },
    };
}

const defaultMode = { permissionMode: 'default' as const };

describe('PermissionHandler remembered Bash commands', () => {
    it('allows token-prefix arguments but rejects command chaining and lookalikes', async () => {
        const harness = createHarness();
        const signal = new AbortController().signal;
        const initial = harness.handler.handleToolCall(
            'Bash',
            { command: 'git status' },
            defaultMode,
            { signal, toolUseID: 'approve-prefix' },
        );
        await harness.permissionRpc({
            id: 'approve-prefix',
            approved: true,
            allowTools: ['Bash(git status:*)'],
        });
        await expect(initial).resolves.toMatchObject({ behavior: 'allow' });

        await expect(harness.handler.handleToolCall(
            'Bash',
            { command: 'git status --short' },
            defaultMode,
            { signal, toolUseID: 'safe-args' },
        )).resolves.toMatchObject({ behavior: 'allow' });

        for (const [id, command] of [
            ['chain', 'git status; rm -rf /'],
            ['and-chain', 'git status && rm -rf /'],
            ['newline', 'git status\nrm -rf /'],
            ['substitution', 'git status $(whoami)'],
            ['lookalike', 'git status-report'],
        ]) {
            const pending = harness.handler.handleToolCall(
                'Bash',
                { command },
                defaultMode,
                { signal, toolUseID: id },
            );
            expect(harness.getState().requests[id]).toBeDefined();
            await harness.permissionRpc({ id, approved: false });
            await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
        }
    });
});
