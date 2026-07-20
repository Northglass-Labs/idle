import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCredentials, streamingFetch } = vi.hoisted(() => ({
    getCredentials: vi.fn(),
    streamingFetch: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: vi.fn() },
    Platform: { OS: 'ios' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials } }));
vi.mock('./storage', () => ({ storage: {} }));
vi.mock('./streamingFetch', () => ({ streamingFetch }));

import { apiSocket } from './apiSocket';

describe('ApiSocket authenticated RPC sender boundary', () => {
    const emitWithAck = vi.fn();
    const sessionExpected = {
        scope: 'session-1',
        method: 'bash',
        requestId: '11111111-1111-4111-8111-111111111111',
    };
    const machineExpected = {
        scope: 'machine-1',
        method: 'spawn-idle-session',
        requestId: '22222222-2222-4222-8222-222222222222',
    };
    const sessionEncryption = {
        encryptRpcRequest: vi.fn(async () => ({
            ciphertext: 'session-request-ciphertext',
            expected: sessionExpected,
        })),
        decryptRpcResponse: vi.fn(async () => ({ success: true })),
    };
    const machineEncryption = {
        encryptRpcRequest: vi.fn(async () => ({
            ciphertext: 'machine-request-ciphertext',
            expected: machineExpected,
        })),
        decryptRpcResponse: vi.fn(async () => ({ success: true })),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        emitWithAck.mockResolvedValue({ ok: true, result: 'response-ciphertext' });
        (apiSocket as any).socket = { emitWithAck };
        (apiSocket as any).config = {
            endpoint: 'https://relay.example.test',
            token: 'socket-token',
        };
        (apiSocket as any).encryption = {
            getSessionEncryption: vi.fn(() => sessionEncryption),
            getMachineEncryption: vi.fn(() => machineEncryption),
        };
        getCredentials.mockResolvedValue({ token: 'http-token', secret: 'client-secret' });
        streamingFetch.mockResolvedValue(new Response(null, { status: 204 }));
    });

    it('forces authenticated HTTP requests to reject redirects', async () => {
        await apiSocket.request('/v1/profile', {
            method: 'POST',
            redirect: 'follow',
        });

        expect(streamingFetch).toHaveBeenCalledWith(
            'https://relay.example.test/v1/profile',
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
                headers: expect.objectContaining({ Authorization: 'Bearer http-token' }),
            }),
        );
    });

    it('uses the authenticated request wrapper for session RPC', async () => {
        await apiSocket.sessionRPC('session-1', 'bash', { command: 'pwd' });

        expect(sessionEncryption.encryptRpcRequest).toHaveBeenCalledWith('bash', { command: 'pwd' });
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', {
            method: 'session-1:bash',
            params: 'session-request-ciphertext',
        });
        expect(sessionEncryption.decryptRpcResponse).toHaveBeenCalledWith(
            'response-ciphertext',
            sessionExpected,
        );
    });

    it('uses the authenticated request wrapper for machine RPC', async () => {
        await apiSocket.machineRPC('machine-1', 'spawn-idle-session', { path: '/workspace' });

        expect(machineEncryption.encryptRpcRequest).toHaveBeenCalledWith(
            'spawn-idle-session',
            { path: '/workspace' },
        );
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', {
            method: 'machine-1:spawn-idle-session',
            params: 'machine-request-ciphertext',
        });
        expect(machineEncryption.decryptRpcResponse).toHaveBeenCalledWith(
            'response-ciphertext',
            machineExpected,
        );
    });

    it.each([
        ['session', () => apiSocket.sessionRPC('session-1', 'bash', { command: 'pwd' }), sessionEncryption],
        ['machine', () => apiSocket.machineRPC('machine-1', 'stop-session', { sessionId: 'session-1' }), machineEncryption],
    ] as const)('rejects an encrypted %s RPC protocol error without exposing its text', async (_kind, invoke, encryption) => {
        const sensitiveMarker = 'PRIVATE_REMOTE_PROTOCOL_ERROR';
        encryption.decryptRpcResponse.mockRejectedValueOnce(
            new Error('Remote control request was rejected'),
        );

        const failure = await invoke().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Remote control request was rejected');
        expect((failure as Error).message).not.toContain(sensitiveMarker);
    });

    it.each([
        ['session', () => apiSocket.sessionRPC('session-1', 'bash', { command: 'pwd' })],
        ['machine', () => apiSocket.machineRPC('machine-1', 'stop-session', { sessionId: 'session-1' })],
    ] as const)('strictly validates a failed %s RPC acknowledgement without exposing relay text', async (_kind, invoke) => {
        const sensitiveMarker = 'PRIVATE_RELAY_RPC_ERROR';
        emitWithAck.mockResolvedValueOnce({ ok: false, error: sensitiveMarker });

        const failure = await invoke().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Remote control request failed');
        expect((failure as Error).message).not.toContain(sensitiveMarker);
    });

    it('rejects malformed acknowledgement envelopes before decryption', async () => {
        emitWithAck.mockResolvedValueOnce({
            ok: true,
            result: 'response-ciphertext',
            attacker: 'unexpected',
        });

        await expect(apiSocket.sessionRPC('session-1', 'bash', { command: 'pwd' }))
            .rejects.toThrow('Invalid RPC response');
        expect(sessionEncryption.decryptRpcResponse).not.toHaveBeenCalled();
    });

    it('does not expose raw transport failures from direct acknowledgement calls', async () => {
        const sensitiveMarker = 'PRIVATE_SOCKET_ACK_FAILURE';
        emitWithAck.mockRejectedValueOnce(new Error(sensitiveMarker));

        const failure = await apiSocket.emitWithAck('machine-update-metadata', {})
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Socket acknowledgement failed');
        expect((failure as Error).message).not.toContain(sensitiveMarker);
    });
});
