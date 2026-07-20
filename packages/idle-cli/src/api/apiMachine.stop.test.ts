import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function stopHandlerFrom(client: ApiMachineClient): (params: unknown) => Promise<unknown> {
    return (client as any).rpcHandlerManager.handlers.get('machine-1:stop-session');
}

describe('ApiMachineClient stop RPC', () => {
    it('does not acknowledge Stop until asynchronous containment succeeds', async () => {
        let finishContainment!: (success: boolean) => void;
        const containment = new Promise<boolean>((resolve) => {
            finishContainment = resolve;
        });
        const stopSession = vi.fn(() => containment);
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession,
            requestShutdown: vi.fn(),
        });

        let acknowledged = false;
        const response = stopHandlerFrom(client)({ sessionId: 'session-1' })
            .then((result) => {
                acknowledged = true;
                return result;
            });

        await Promise.resolve();
        expect(stopSession).toHaveBeenCalledWith('session-1');
        expect(acknowledged).toBe(false);

        finishContainment(true);
        await expect(response).resolves.toEqual({ message: 'Session stopped' });
        expect(acknowledged).toBe(true);
    });

    it('rejects Stop when containment fails', async () => {
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(async () => false),
            requestShutdown: vi.fn(),
        });

        await expect(stopHandlerFrom(client)({ sessionId: 'session-1' }))
            .rejects.toThrow('Session not found or failed to stop');
    });
});
