import { describe, expect, it, vi } from 'vitest';
import { createAuthenticatedRpcSuccess } from '@northglass/idle-wire';

vi.mock('expo-crypto', () => ({
    randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
}));

import { MachineEncryption } from './machineEncryption';

describe('MachineEncryption authenticated RPC sender boundary', () => {
    it('encrypts RPC params inside a fresh machine- and method-bound request', async () => {
        const encryptor = {
            encrypt: vi.fn(async () => [new Uint8Array([1, 2, 3])]),
            decrypt: vi.fn(),
        };
        const encryption = new MachineEncryption('machine-1', encryptor as any, {} as any);

        const encrypted = await encryption.encryptRpcRequest(
            'spawn-idle-session',
            { path: '/workspace' },
        );

        expect(encryptor.encrypt).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'idle-rpc-request',
                v: 2,
                scope: 'machine-1',
                method: 'spawn-idle-session',
                requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                issuedAt: expect.any(Number),
                params: { path: '/workspace' },
            }),
        ]);
        expect(encrypted).toEqual({
            ciphertext: 'AQID',
            expected: {
                scope: 'machine-1',
                method: 'spawn-idle-session',
                requestId: '11111111-1111-4111-8111-111111111111',
            },
        });
    });

    it('rejects a valid response captured from a different request', async () => {
        const firstIdentity = {
            scope: 'machine-1',
            method: 'spawn-idle-session',
            requestId: '11111111-1111-4111-8111-111111111111',
        };
        const encryptor = {
            encrypt: vi.fn(),
            decrypt: vi.fn(async () => [createAuthenticatedRpcSuccess({
                ...firstIdentity,
                requestId: '22222222-2222-4222-8222-222222222222',
            }, { type: 'success', sessionId: 'session-replayed' })]),
        };
        const encryption = new MachineEncryption('machine-1', encryptor as any, {} as any);

        await expect(encryption.decryptRpcResponse('AQID', firstIdentity))
            .rejects.toThrow('Invalid RPC response');
    });
});
