import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    RPC_REQUEST_MAX_AGE_MS,
    RPC_REQUEST_MAX_FUTURE_SKEW_MS,
    createAuthenticatedRpcRequest,
} from '@northglass/idle-wire';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from './RpcHandlerManager';
import type { RpcHandlerConfig } from './types';

describe('RpcHandlerManager authenticated payload boundary', () => {
    const key = new Uint8Array(32).fill(7);
    let defaultReplayRoot: string;

    beforeEach(() => {
        defaultReplayRoot = mkdtempSync(join(tmpdir(), 'idle-rpc-test-default-'));
    });

    afterEach(() => {
        rmSync(defaultReplayRoot, { recursive: true, force: true });
    });

    function createManager(overrides: Partial<RpcHandlerConfig> = {}) {
        return new RpcHandlerManager({
            scopePrefix: 'session-1',
            encryptionKey: key,
            encryptionVariant: 'legacy',
            logger: vi.fn(),
            replayStoreDirectory: join(defaultReplayRoot, 'replay'),
            ...overrides,
        });
    }

    function authenticatedRequest(
        params: unknown,
        overrides: Partial<{
            scope: string;
            method: string;
            requestId: string;
            issuedAt: number;
        }> = {},
    ) {
        return {
            kind: 'idle-rpc-request',
            v: 1,
            scope: overrides.scope ?? 'session-1',
            method: overrides.method ?? 'bash',
            requestId: overrides.requestId ?? '11111111-1111-4111-8111-111111111111',
            issuedAt: overrides.issuedAt ?? 1_750_000_000_000,
            params,
        };
    }

    it('does not dispatch a handler when ciphertext authentication fails', async () => {
        const manager = createManager();
        const destructiveHandler = vi.fn(async () => ({ stopped: true }));
        manager.registerHandler('stop', destructiveHandler);

        const response = await manager.handleRequest({
            method: 'session-1:stop',
            params: encodeBase64(new Uint8Array(64).fill(42)),
        });

        expect(destructiveHandler).not.toHaveBeenCalled();
        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
            error: 'Invalid RPC payload',
        });
    });

    it('dispatches a valid current request with only its inner params', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-valid-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            const handler = vi.fn(async (params: unknown) => ({ echoed: params }));
            manager.registerHandler('echo', handler);
            const params = { value: 'hello' };

            const response = await manager.handleRequest({
                method: 'session-1:echo',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    params,
                    { method: 'echo', issuedAt: now },
                ))),
            });

            expect(handler).toHaveBeenCalledWith(params);
            expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({ echoed: params });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('binds a v2 success response to the exact authenticated request identity', async () => {
        const now = 1_750_000_000_000;
        const manager = createManager({ now: () => now });
        manager.registerHandler('echo', async (params: unknown) => ({ echoed: params }));
        const request = createAuthenticatedRpcRequest(
            'session-1',
            'echo',
            { value: 'hello' },
            '11111111-1111-4111-8111-111111111111',
            now,
        );

        const response = await manager.handleRequest({
            method: 'session-1:echo',
            params: encodeBase64(encrypt(key, 'legacy', request)),
        });

        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
            kind: 'idle-rpc-response',
            v: 2,
            scope: 'session-1',
            method: 'echo',
            requestId: request.requestId,
            ok: true,
            result: { echoed: { value: 'hello' } },
        });
    });

    it.each([
        ['missing', undefined, 'METHOD_NOT_FOUND'],
        ['failing', async () => { throw new Error('private failure'); }, 'HANDLER_FAILED'],
        ['large', async () => 'x'.repeat(16 * 1024 * 1024 + 1), 'RESULT_TOO_LARGE'],
    ] as const)('binds a v2 %s error without returning handler text', async (method, handler, code) => {
        const now = 1_750_000_000_000;
        const manager = createManager({ now: () => now });
        if (handler) manager.registerHandler(method, handler);
        const request = createAuthenticatedRpcRequest(
            'session-1',
            method,
            {},
            '11111111-1111-4111-8111-111111111111',
            now,
        );

        const response = await manager.handleRequest({
            method: `session-1:${method}`,
            params: encodeBase64(encrypt(key, 'legacy', request)),
        });

        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
            kind: 'idle-rpc-response',
            v: 2,
            scope: 'session-1',
            method,
            requestId: request.requestId,
            ok: false,
            error: code,
        });
    });

    it.each(['legacy', 'dataKey'] as const)(
        'rejects legacy raw %s params without invoking a handler',
        async (encryptionVariant) => {
            const manager = new RpcHandlerManager({
                scopePrefix: 'session-1',
                encryptionKey: key,
                encryptionVariant,
                logger: vi.fn(),
                replayStoreDirectory: join(defaultReplayRoot, `replay-${encryptionVariant}`),
            });
            const destructiveHandler = vi.fn(async () => ({ stopped: true }));
            manager.registerHandler('stop', destructiveHandler);
            const response = await manager.handleRequest({
                method: 'session-1:stop',
                params: encodeBase64(encrypt(key, encryptionVariant, { force: true })),
            });

            expect(decrypt(key, encryptionVariant, decodeBase64(response))).toEqual({
                error: 'Invalid authenticated RPC request',
            });
            expect(destructiveHandler).not.toHaveBeenCalled();
        },
    );

    it('durably consumes a current request before awaiting the handler', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-concurrent-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            let release!: () => void;
            const handler = vi.fn(() => new Promise((resolve) => {
                release = () => resolve({ stopped: true });
            }));
            manager.registerHandler('stop', handler);
            const request = {
                method: 'session-1:stop',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { force: true },
                    { method: 'stop', issuedAt: now },
                ))),
            };

            const first = manager.handleRequest(request);
            await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
            const replay = await manager.handleRequest(request);
            release();
            await first;

            expect(decrypt(key, 'legacy', decodeBase64(replay))).toEqual({
                error: 'RPC request replayed',
            });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects a current authenticated request after the handler manager restarts', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-restart-'));
        try {
            const now = 1_750_000_000_000;
            const replayStoreDirectory = join(root, 'replay');
            const destructiveHandler = vi.fn(async () => ({ stopped: true }));
            const request = {
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: 'perform-once' },
                    { issuedAt: now },
                ))),
            };

            const firstManager = createManager({ replayStoreDirectory, now: () => now });
            firstManager.registerHandler('bash', destructiveHandler);
            const first = await firstManager.handleRequest(request);

            const restartedManager = createManager({ replayStoreDirectory, now: () => now });
            restartedManager.registerHandler('bash', destructiveHandler);
            const replay = await restartedManager.handleRequest(request);

            expect(decrypt(key, 'legacy', decodeBase64(first))).toEqual({ stopped: true });
            expect(decrypt(key, 'legacy', decodeBase64(replay))).toEqual({
                error: 'RPC request replayed',
            });
            expect(destructiveHandler).toHaveBeenCalledTimes(1);
            expect(destructiveHandler).toHaveBeenCalledWith({ command: 'perform-once' });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed at durable replay capacity without evicting an executable identity', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-capacity-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({
                replayStoreDirectory: join(root, 'replay'),
                replayStoreMaxEntries: 2,
                now: () => now,
            });
            const handler = vi.fn(async () => ({ ok: true }));
            manager.registerHandler('bash', handler);
            const request = (requestId: string) => ({
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: requestId },
                    { requestId, issuedAt: now },
                ))),
            });
            const firstRequest = request('11111111-1111-4111-8111-111111111111');

            await manager.handleRequest(firstRequest);
            await manager.handleRequest(request('22222222-2222-4222-8222-222222222222'));
            const saturated = await manager.handleRequest(request('33333333-3333-4333-8333-333333333333'));
            const replay = await manager.handleRequest(firstRequest);

            expect(decrypt(key, 'legacy', decodeBase64(saturated))).toEqual({
                error: 'RPC replay protection unavailable',
            });
            expect(decrypt(key, 'legacy', decodeBase64(replay))).toEqual({
                error: 'RPC request replayed',
            });
            expect(handler).toHaveBeenCalledTimes(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects the same authenticated request identity after it is re-encrypted', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-reencrypted-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            const handler = vi.fn(async () => ({ ok: true }));
            manager.registerHandler('bash', handler);
            const payload = authenticatedRequest({ command: 'perform-once' }, { issuedAt: now });
            const first = {
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', payload)),
            };
            const reEncryptedReplay = {
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', payload)),
            };

            await manager.handleRequest(first);
            const replay = await manager.handleRequest(reEncryptedReplay);

            expect(reEncryptedReplay.params).not.toBe(first.params);
            expect(decrypt(key, 'legacy', decodeBase64(replay))).toEqual({ error: 'RPC request replayed' });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('spends a fresh identity before rejecting a relay-altered outer route', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-route-replay-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            const handler = vi.fn(async () => ({ ok: true }));
            manager.registerHandler('bash', handler);
            const ciphertext = encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                { command: 'perform-once' },
                { issuedAt: now },
            )));

            const alteredRoute = await manager.handleRequest({
                method: 'session-1:not-registered',
                params: ciphertext,
            });
            const originalRouteReplay = await manager.handleRequest({
                method: 'session-1:bash',
                params: ciphertext,
            });

            expect(decrypt(key, 'legacy', decodeBase64(alteredRoute))).toEqual({
                error: 'Invalid authenticated RPC request',
            });
            expect(decrypt(key, 'legacy', decodeBase64(originalRouteReplay))).toEqual({
                error: 'RPC request replayed',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('spends a fresh identity before returning method not found', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-missing-handler-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            const handler = vi.fn(async () => ({ ok: true }));
            const request = {
                method: 'session-1:later-handler',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { action: 'perform-once' },
                    { method: 'later-handler', issuedAt: now },
                ))),
            };

            const unavailable = await manager.handleRequest(request);
            manager.registerHandler('later-handler', handler);
            const replay = await manager.handleRequest(request);

            expect(decrypt(key, 'legacy', decodeBase64(unavailable))).toEqual({
                error: 'Method not found',
            });
            expect(decrypt(key, 'legacy', decodeBase64(replay))).toEqual({
                error: 'RPC request replayed',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['scope', { scope: 'session-2' }, 'session-1:bash'],
        ['method', { method: 'stop' }, 'session-1:bash'],
    ] as const)('rejects an authenticated %s that does not match the outer route', async (_label, overrides, method) => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-route-mismatch-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            const handler = vi.fn();
            manager.registerHandler('bash', handler);

            const response = await manager.handleRequest({
                method,
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: 'never-run' },
                    { ...overrides, issuedAt: now },
                ))),
            });

            expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
                error: 'Invalid authenticated RPC request',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each([
        ['expired', -(RPC_REQUEST_MAX_AGE_MS + 1)],
        ['future-dated', RPC_REQUEST_MAX_FUTURE_SKEW_MS + 1],
    ] as const)('rejects a %s authenticated request before dispatch', async (_label, offset) => {
        const now = 1_750_000_000_000;
        const manager = createManager({ now: () => now });
        const handler = vi.fn();
        manager.registerHandler('bash', handler);

        const response = await manager.handleRequest({
            method: 'session-1:bash',
            params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                { command: 'never-run' },
                { issuedAt: now + offset },
            ))),
        });

        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({ error: 'RPC request expired' });
        expect(handler).not.toHaveBeenCalled();
    });

    it('does not downgrade a malformed current envelope to raw params', async () => {
        const now = 1_750_000_000_000;
        const manager = createManager({ now: () => now });
        const handler = vi.fn();
        manager.registerHandler('bash', handler);
        const malformed = { ...authenticatedRequest({ command: 'never-run' }, { issuedAt: now }), v: 3 };

        const response = await manager.handleRequest({
            method: 'session-1:bash',
            params: encodeBase64(encrypt(key, 'legacy', malformed)),
        });

        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
            error: 'Invalid authenticated RPC request',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('atomically rejects a cross-process race for the same request identity', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-race-'));
        try {
            const now = 1_750_000_000_000;
            const replayStoreDirectory = join(root, 'replay');
            const handler = vi.fn(async () => ({ ok: true }));
            const firstManager = createManager({ replayStoreDirectory, now: () => now });
            const secondManager = createManager({ replayStoreDirectory, now: () => now });
            firstManager.registerHandler('bash', handler);
            secondManager.registerHandler('bash', handler);
            const request = {
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: 'perform-once' },
                    { issuedAt: now },
                ))),
            };

            const responses = await Promise.all([
                firstManager.handleRequest(request),
                secondManager.handleRequest(request),
            ]);
            const plaintext = responses.map((response) => decrypt(key, 'legacy', decodeBase64(response)));

            expect(plaintext).toContainEqual({ ok: true });
            expect(plaintext).toContainEqual({ error: 'RPC request replayed' });
            expect(handler).toHaveBeenCalledTimes(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('persists only an owner-only digest marker, never RPC identity or params', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-marker-'));
        try {
            const now = 1_750_000_000_000;
            const replayStoreDirectory = join(root, 'replay');
            const manager = createManager({ replayStoreDirectory, now: () => now });
            manager.registerHandler('bash', async () => ({ ok: true }));
            const secretCommand = 'private-command-never-persist';

            await manager.handleRequest({
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: secretCommand },
                    { issuedAt: now },
                ))),
            });

            const entries = readdirSync(replayStoreDirectory);
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatch(/^[a-f0-9]{64}\.seen$/);
            expect(entries[0]).not.toContain('session-1');
            const markerPath = join(replayStoreDirectory, entries[0]!);
            expect(readFileSync(markerPath, 'utf8')).toBe('v1\n');
            expect(readFileSync(markerPath, 'utf8')).not.toContain(secretCommand);
            if (process.platform !== 'win32') {
                expect(statSync(replayStoreDirectory).mode & 0o777).toBe(0o700);
                expect(statSync(markerPath).mode & 0o777).toBe(0o600);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails closed when the replay directory is a symbolic link', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-symlink-'));
        try {
            const now = 1_750_000_000_000;
            const target = join(root, 'target');
            const replayStoreDirectory = join(root, 'replay');
            mkdirSync(target);
            symlinkSync(target, replayStoreDirectory, 'dir');
            const manager = createManager({ replayStoreDirectory, now: () => now });
            const handler = vi.fn();
            manager.registerHandler('bash', handler);

            const response = await manager.handleRequest({
                method: 'session-1:bash',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    { command: 'never-run' },
                    { issuedAt: now },
                ))),
            });

            expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
                error: 'RPC replay protection unavailable',
            });
            expect(handler).not.toHaveBeenCalled();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects oversized request ciphertext before decoding or dispatching it', async () => {
        const manager = createManager();
        const handler = vi.fn();
        manager.registerHandler('stop', handler);

        const response = await manager.handleRequest({
            method: 'session-1:stop',
            params: 'x'.repeat(16 * 1024 * 1024 + 1),
        });

        expect(handler).not.toHaveBeenCalled();
        expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
            error: 'Invalid RPC request',
        });
    });

    it('rejects an oversized handler result before encrypting it for the relay', async () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-rpc-response-'));
        try {
            const now = 1_750_000_000_000;
            const manager = createManager({ replayStoreDirectory: join(root, 'replay'), now: () => now });
            manager.registerHandler('read', async () => 'x'.repeat(16 * 1024 * 1024 + 1));

            const response = await manager.handleRequest({
                method: 'session-1:read',
                params: encodeBase64(encrypt(key, 'legacy', authenticatedRequest(
                    {},
                    { method: 'read', issuedAt: now },
                ))),
            });

            expect(decrypt(key, 'legacy', decodeBase64(response))).toEqual({
                error: 'RPC response too large',
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
