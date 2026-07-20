import { describe, expect, it, vi } from 'vitest';

import { ApiMachineClient } from './apiMachine';

const VALID_CLAUDE_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function spawnHandlerFrom(client: ApiMachineClient): (params: unknown) => Promise<unknown> {
    const handlers = (client as any).rpcHandlerManager.handlers as Map<string, (params: unknown) => Promise<unknown>>;
    const handler = handlers.get('machine-1:spawn-idle-session');
    if (!handler) {
        throw new Error('spawn-idle-session handler was not registered');
    }
    return handler;
}

describe('ApiMachineClient Claude resume spawn boundary', () => {
    it.each([
        '../../outside-project/session',
        'not-a-uuid',
    ])('rejects %j before it reaches spawnSession', async (resumeClaudeSessionId) => {
        const spawnSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'must-not-spawn',
        });
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        await expect(spawnHandlerFrom(client)({
            directory: '/tmp/project',
            agent: 'claude',
            resumeClaudeSessionId,
        })).rejects.toThrow(/resumeClaudeSessionId must be a valid UUID/);

        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('preserves a valid Claude resume UUID unchanged', async () => {
        const spawnSession = vi.fn().mockResolvedValue({
            type: 'success',
            sessionId: 'idle-forked',
        });
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        await expect(spawnHandlerFrom(client)({
            directory: '/tmp/project',
            agent: 'claude',
            resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID,
        })).resolves.toEqual({ type: 'success', sessionId: 'idle-forked' });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID,
        }));
    });
});
