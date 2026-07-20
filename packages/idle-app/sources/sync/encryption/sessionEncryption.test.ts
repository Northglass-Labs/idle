import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createAuthenticatedRpcSuccess,
    createAuthenticatedSessionFieldEnvelope,
    MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES,
} from '@northglass/idle-wire';

vi.mock('expo-crypto', () => ({
    randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: vi.fn(async (_algorithm: string, value: string) => `digest:${value}`),
}));
vi.mock('@/encryption/aes', async () => await import('@/encryption/aes.web'));

import { SessionEncryption } from './sessionEncryption';
import { EncryptionCache } from './encryptionCache';
import { AES256Encryption } from './encryptor';
import type { RawRecord } from '../typesRaw';

function createHarness() {
    const cache = {
        getCachedMessage: vi.fn(() => null),
        setCachedMessage: vi.fn(),
        getCachedMetadata: vi.fn(() => ({ status: 'miss' })),
        setCachedMetadata: vi.fn(),
        getCachedAgentState: vi.fn(() => ({ status: 'miss' })),
        setCachedAgentState: vi.fn(),
    };
    const encryptor = {
        encrypt: vi.fn(),
        decrypt: vi.fn(async (items: Uint8Array[]) => items.map(() => ({ path: '/workspace' }))),
    };
    return {
        cache,
        encryptor,
        encryption: new SessionEncryption('session-1', encryptor as any, cache as any),
    };
}

describe('SessionEncryption malformed ciphertext isolation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('isolates an invalid message without aborting the rest of the batch', async () => {
        const { encryption } = createHarness();
        const messages = [
            {
                id: 'bad', seq: 1, localId: null, createdAt: 1,
                content: { t: 'encrypted', c: '***not-base64***' },
            },
            {
                id: 'good', seq: 2, localId: null, createdAt: 2,
                content: { t: 'encrypted', c: 'AQID' },
            },
        ];

        await expect(encryption.decryptMessages(messages as any)).resolves.toEqual([
            expect.objectContaining({ id: 'bad', content: null }),
            expect.objectContaining({ id: 'good', content: { path: '/workspace' } }),
        ]);
    });

    it('rejects oversized ciphertext before base64 decode or decryption', async () => {
        const { encryption, encryptor } = createHarness();
        const oversized = Buffer.alloc(MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES + 1).toString('base64');

        await expect(encryption.decryptMessage({
            id: 'oversized',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: { t: 'encrypted', c: oversized },
        } as any)).resolves.toMatchObject({ id: 'oversized', content: null });
        expect(encryptor.decrypt).not.toHaveBeenCalled();
    });

    it('returns null for malformed metadata', async () => {
        const { encryption } = createHarness();
        await expect(encryption.decryptMetadata(1, '***not-base64***')).resolves.toBeNull();
    });

    it('returns an empty state for malformed agent state', async () => {
        const { encryption } = createHarness();
        await expect(encryption.decryptAgentState(1, '***not-base64***')).resolves.toEqual({});
    });

    it('distinguishes a legitimate empty agent state from failed authentication', async () => {
        const { encryption } = createHarness();

        await expect(encryption.decryptAgentStateResult(1, null)).resolves.toEqual({
            success: false,
        });
        await expect(encryption.decryptAgentState(1, null)).resolves.toEqual({});
        await expect(encryption.decryptAgentStateResult(2, '***not-base64***')).resolves.toEqual({
            success: false,
        });
    });

    it('bounds decrypted AgentState before returning or caching it', async () => {
        const { encryption, encryptor, cache } = createHarness();
        const payload = 'A'.repeat(4 * 1024 * 1024);
        const requests = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
            `request-${index}`,
            { tool: 'Task', arguments: { payload }, createdAt: index + 1 },
        ]));
        encryptor.decrypt.mockResolvedValueOnce([
            createAuthenticatedSessionFieldEnvelope(
                'session-1',
                'agentState',
                1,
                { requests },
            ),
        ]);

        const decrypted = await encryption.decryptAgentStateResult(1, 'AQID');
        expect(decrypted.success).toBe(true);
        const result = decrypted.success ? decrypted.value : {};

        expect(Object.keys(result.requests ?? {}).length).toBeGreaterThanOrEqual(1);
        expect(Object.keys(result.requests ?? {}).length).toBeLessThan(10);
        expect(cache.setCachedAgentState).toHaveBeenCalledWith(
            'session-1',
            1,
            'digest:AQID',
            result,
        );
    });

    it('encrypts outgoing records with a session-bound message identity', async () => {
        const { encryption, encryptor } = createHarness();
        encryptor.encrypt.mockResolvedValueOnce([new Uint8Array([1, 2, 3])]);
        const record: RawRecord = {
            role: 'user',
            content: { type: 'text', text: 'authenticated prompt' },
        };

        await encryption.encryptRawRecord(record, 'mobile-message-1');

        expect(encryptor.encrypt).toHaveBeenCalledWith([{
            ...record,
            messageIdentity: {
                v: 1,
                sessionId: 'session-1',
                messageId: 'mobile-message-1',
            },
        }]);
    });

    it('encrypts RPC params inside a fresh session- and method-bound request', async () => {
        const { encryption, encryptor } = createHarness();
        encryptor.encrypt.mockResolvedValueOnce([new Uint8Array([1, 2, 3])]);

        const encrypted = await encryption.encryptRpcRequest('bash', { command: 'pwd' });

        expect(encryptor.encrypt).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'idle-rpc-request',
                v: 2,
                scope: 'session-1',
                method: 'bash',
                requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                issuedAt: expect.any(Number),
                params: { command: 'pwd' },
            }),
        ]);
        expect(encrypted).toEqual({
            ciphertext: 'AQID',
            expected: {
                scope: 'session-1',
                method: 'bash',
                requestId: '11111111-1111-4111-8111-111111111111',
            },
        });
    });

    it('rejects a response whose authenticated method does not match the request', async () => {
        const expected = {
            scope: 'session-1',
            method: 'bash',
            requestId: '11111111-1111-4111-8111-111111111111',
        };
        const { encryption, encryptor } = createHarness();
        encryptor.decrypt.mockResolvedValueOnce([createAuthenticatedRpcSuccess({
            ...expected,
            method: 'permission',
        }, { success: true })]);

        await expect(encryption.decryptRpcResponse('AQID', expected))
            .rejects.toThrow('Invalid RPC response');
    });
});

describe('SessionEncryption cache isolation', () => {
    it('rejects same-version ciphertext equivocation while keeping exact replay inert', async () => {
        const aead = new AES256Encryption(new Uint8Array(32).fill(29));
        const [firstAgentCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                7,
                { controlledByUser: false },
            ),
        ]);
        const [equivocatingAgentCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                7,
                { controlledByUser: true },
            ),
        ]);
        const [newerAgentCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                8,
                { controlledByUser: true },
            ),
        ]);
        const first = Buffer.from(firstAgentCiphertext).toString('base64');
        const equivocation = Buffer.from(equivocatingAgentCiphertext).toString('base64');
        const newer = Buffer.from(newerAgentCiphertext).toString('base64');
        const reader = new SessionEncryption('session-a', aead, new EncryptionCache());

        await expect(reader.decryptAgentStateResult(7, first)).resolves.toMatchObject({
            success: true,
            value: { controlledByUser: false },
        });
        await expect(reader.decryptAgentStateResult(7, first)).resolves.toMatchObject({
            success: true,
            value: { controlledByUser: false },
        });
        await expect(reader.decryptAgentStateResult(7, equivocation)).resolves.toEqual({
            success: false,
        });
        await expect(reader.decryptAgentStateResult(8, newer)).resolves.toMatchObject({
            success: true,
            value: { controlledByUser: true },
        });
    });

    it('atomically accepts only one of two concurrent same-version ciphertexts', async () => {
        const aead = new AES256Encryption(new Uint8Array(32).fill(31));
        const [firstCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                9,
                { controlledByUser: false },
            ),
        ]);
        const [secondCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                9,
                { controlledByUser: true },
            ),
        ]);
        const reader = new SessionEncryption('session-a', aead, new EncryptionCache());

        const results = await Promise.all([
            reader.decryptAgentStateResult(
                9,
                Buffer.from(firstCiphertext).toString('base64'),
            ),
            reader.decryptAgentStateResult(
                9,
                Buffer.from(secondCiphertext).toString('base64'),
            ),
        ]);

        expect(results.filter((result) => result.success)).toHaveLength(1);
        expect(results.filter((result) => !result.success)).toHaveLength(1);
    });

    it('keeps one exact winner across many concurrent randomized same-version candidates', async () => {
        const aead = new AES256Encryption(new Uint8Array(32).fill(37));
        const candidates = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
            const [ciphertext] = await aead.encrypt([
                createAuthenticatedSessionFieldEnvelope(
                    'session-a',
                    'agentState',
                    19,
                    { controlledByUser: index % 2 === 0 },
                ),
            ]);
            return Buffer.from(ciphertext).toString('base64');
        }));
        expect(new Set(candidates).size).toBe(candidates.length);

        const reader = new SessionEncryption('session-a', aead, new EncryptionCache());
        const firstPass = await Promise.all(
            candidates.map((candidate) => reader.decryptAgentStateResult(19, candidate)),
        );
        const winnerIndex = firstPass.findIndex((result) => result.success);

        expect(winnerIndex).toBeGreaterThanOrEqual(0);
        expect(firstPass.filter((result) => result.success)).toHaveLength(1);
        await expect(reader.decryptAgentStateResult(19, candidates[winnerIndex]!)).resolves.toMatchObject({
            success: true,
            binding: 'bound',
        });

        const loserReplays = await Promise.all(candidates
            .filter((_, index) => index !== winnerIndex)
            .map((candidate) => reader.decryptAgentStateResult(19, candidate)));
        expect(loserReplays.every((result) => !result.success)).toBe(true);
    });

    it('rejects authentic field ciphertext relabeled to a newer version after a cold start', async () => {
        const aead = new AES256Encryption(new Uint8Array(32).fill(7));
        const [agentCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'agentState',
                1,
                {
                    requests: {
                        captured: {
                            tool: 'Bash',
                            arguments: { command: 'pwd' },
                            createdAt: 1,
                        },
                    },
                },
            ),
        ]);
        const [metadataCiphertext] = await aead.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                'session-a',
                'metadata',
                1,
                { path: '/workspace', host: 'mac-mini' },
            ),
        ]);
        const encodedAgentState = Buffer.from(agentCiphertext).toString('base64');
        const encodedMetadata = Buffer.from(metadataCiphertext).toString('base64');

        // A fresh reader/cache models an app restart: no process-local replay
        // marker can be responsible for rejecting the relabeled ciphertext.
        const reader = new SessionEncryption('session-a', aead, new EncryptionCache());
        const otherSessionReader = new SessionEncryption('session-b', aead, new EncryptionCache());

        await expect(reader.decryptAgentStateResult(1, encodedAgentState)).resolves.toMatchObject({
            success: true,
            value: { requests: { captured: expect.any(Object) } },
        });
        await expect(reader.decryptAgentStateResult(999, encodedAgentState)).resolves.toEqual({
            success: false,
        });
        await expect(otherSessionReader.decryptAgentStateResult(1, encodedAgentState)).resolves.toEqual({
            success: false,
        });
        await expect(reader.decryptMetadata(1, encodedMetadata)).resolves.toEqual({
            path: '/workspace',
            host: 'mac-mini',
        });
        await expect(reader.decryptMetadata(999, encodedMetadata)).resolves.toBeNull();
    });

    it('never reuses decrypted plaintext across sessions with the same message id', async () => {
        const cache = new EncryptionCache();
        const decryptA = vi.fn(async () => [{ source: 'session-a' }]);
        const decryptB = vi.fn(async () => [{ source: 'session-b' }]);
        const sessionA = new SessionEncryption('session-a', { encrypt: vi.fn(), decrypt: decryptA } as any, cache);
        const sessionB = new SessionEncryption('session-b', { encrypt: vi.fn(), decrypt: decryptB } as any, cache);

        const envelope = {
            id: 'relay-reused-id',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: { t: 'encrypted', c: 'AQID' },
        } as any;

        await expect(sessionA.decryptMessage(envelope)).resolves.toMatchObject({ content: { source: 'session-a' } });
        await expect(sessionB.decryptMessage({
            ...envelope,
            content: { t: 'encrypted', c: 'BAUG' },
        })).resolves.toMatchObject({ content: { source: 'session-b' } });

        expect(decryptA).toHaveBeenCalledOnce();
        expect(decryptB).toHaveBeenCalledOnce();
    });

    it('keeps adversarial delimiter-containing session and message ids isolated', async () => {
        const cache = new EncryptionCache();
        const decryptA = vi.fn(async () => [{ source: 'session-a' }]);
        const decryptB = vi.fn(async () => [{ source: 'session-b' }]);
        const sessionA = new SessionEncryption('a', { encrypt: vi.fn(), decrypt: decryptA } as any, cache);
        const sessionB = new SessionEncryption('a\0b', { encrypt: vi.fn(), decrypt: decryptB } as any, cache);

        await sessionA.decryptMessage({
            id: 'b\0c',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: { t: 'encrypted', c: 'AQID' },
        } as any);
        await expect(sessionB.decryptMessage({
            id: 'c',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: { t: 'encrypted', c: 'BAUG' },
        } as any)).resolves.toMatchObject({ content: { source: 'session-b' } });

        expect(decryptA).toHaveBeenCalledOnce();
        expect(decryptB).toHaveBeenCalledOnce();
    });

    it('clears only the exact session when ids contain the cache delimiter', () => {
        const cache = new EncryptionCache();
        const message = {
            id: 'message',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: { source: 'fixture' },
        } as any;

        cache.setCachedMessage('a', 'message-a', message);
        cache.setCachedMessage('a\0b', 'message-b', message);
        cache.clearSessionCache('a');

        expect(cache.getCachedMessage('a', 'message-a')).toBeNull();
        expect(cache.getCachedMessage('a\0b', 'message-b')).toBe(message);
    });
});
