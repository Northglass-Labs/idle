import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findUniqueMock, updateManyMock, fsMocks } = vi.hoisted(() => {
    return {
        findUniqueMock: vi.fn(),
        updateManyMock: vi.fn(),
        fsMocks: {
            constants: {
                O_RDONLY: 0,
                O_NOFOLLOW: 0x100,
            },
            existsSync: vi.fn().mockReturnValue(false),
            readFileSync: vi.fn().mockReturnValue(''),
            openSync: vi.fn(),
            fstatSync: vi.fn(),
            readSync: vi.fn(),
            closeSync: vi.fn(),
            fchmodSync: vi.fn(),
            writeFileSync: vi.fn(),
            renameSync: vi.fn(),
            mkdirSync: vi.fn(),
            chmodSync: vi.fn(),
        },
    };
});

// Mock db module — use relative path (tsconfig aliases don't resolve in vi.mock)
vi.mock('../../storage/db', () => ({
    db: {
        account: {
            findUnique: findUniqueMock,
            updateMany: updateManyMock,
        },
    },
}));

// Mock fs for revocation persistence tests
vi.mock('fs', () => ({
    constants: fsMocks.constants,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    openSync: fsMocks.openSync,
    fstatSync: fsMocks.fstatSync,
    readSync: fsMocks.readSync,
    closeSync: fsMocks.closeSync,
    fchmodSync: fsMocks.fchmodSync,
    writeFileSync: fsMocks.writeFileSync,
    renameSync: fsMocks.renameSync,
    mkdirSync: fsMocks.mkdirSync,
    chmodSync: fsMocks.chmodSync,
}));

// Mock privacy-kit so auth.init() doesn't need a real master secret
vi.mock('privacy-kit', () => ({
    createPersistentTokenGenerator: vi.fn().mockResolvedValue({
        publicKey: new Uint8Array(32),
        new: vi.fn().mockResolvedValue('mock-token'),
    }),
    createPersistentTokenVerifier: vi.fn().mockResolvedValue({
        verify: vi.fn().mockResolvedValue(null),
    }),
}));

// Mock log to avoid noise
vi.mock('../../utils/log', () => ({
    log: vi.fn(),
}));

import { auth } from './auth';
import { setRuntimeMasterSecret } from '../../utils/runtimeMasterSecret';

const REVOCATION_FD = 41;
const MAX_REVOCATION_FILE_BYTES = 1024 * 1024;
const MAX_PERSISTED_REVOCATIONS = 10_000;
const MAX_PERSISTED_TOKEN_BYTES = 16 * 1024;

function missingFileError(): NodeJS.ErrnoException {
    return Object.assign(new Error('missing revocation file'), { code: 'ENOENT' });
}

function configureMissingRevocationFile(): void {
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.openSync.mockImplementation(() => {
        throw missingFileError();
    });
}

function configureRevocationFile(
    raw: string,
    overrides: {
        size?: number;
        uid?: number;
        mode?: number;
        isFile?: boolean;
        trailingByte?: boolean;
    } = {},
): void {
    const contents = Buffer.from(raw, 'utf8');
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(raw);
    fsMocks.openSync.mockReturnValue(REVOCATION_FD);
    fsMocks.fstatSync.mockReturnValue({
        isFile: () => overrides.isFile ?? true,
        size: overrides.size ?? contents.length,
        uid: overrides.uid ?? process.getuid?.() ?? 0,
        mode: overrides.mode ?? 0o100600,
    });
    fsMocks.readSync.mockImplementation((
        _descriptor: number,
        target: Buffer,
        targetOffset: number,
        length: number,
        position: number,
    ) => {
        if (overrides.trailingByte && position >= contents.length) {
            target[targetOffset] = 0x78;
            return 1;
        }
        const bytesRead = Math.min(length, Math.max(0, contents.length - position));
        contents.copy(target, targetOffset, position, position + bytesRead);
        return bytesRead;
    });
}

beforeEach(() => {
    fsMocks.openSync.mockReset();
    fsMocks.fstatSync.mockReset();
    fsMocks.readSync.mockReset();
    fsMocks.closeSync.mockReset();
    fsMocks.fchmodSync.mockReset();
    configureMissingRevocationFile();
});

describe('token account verification', () => {
    beforeEach(async () => {
        findUniqueMock.mockReset();
        updateManyMock.mockReset();
        setRuntimeMasterSecret('a0'.repeat(32));
        await auth.init();
    });

    afterEach(() => {
        // Clear the account cache between tests
        auth.invalidateAccountCache('existing-user');
        auth.invalidateAccountCache('deleted-user');
        auth.invalidateAccountCache('user-to-delete');
    });

    it('should return true when account exists in DB', async () => {
        findUniqueMock.mockResolvedValue({ id: 'existing-user' });

        const result = await auth.verifyAccountExists('existing-user');

        expect(result).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledWith({
            where: { id: 'existing-user' },
            select: { id: true, authVersion: true, authSuspendedAt: true },
        });
    });

    it('should return false when account does not exist in DB', async () => {
        findUniqueMock.mockResolvedValue(null);

        const result = await auth.verifyAccountExists('deleted-user');

        expect(result).toBe(false);
        expect(findUniqueMock).toHaveBeenCalledWith({
            where: { id: 'deleted-user' },
            select: { id: true, authVersion: true, authSuspendedAt: true },
        });
    });

    it('should cache account existence to avoid repeated DB queries', async () => {
        findUniqueMock.mockResolvedValue({ id: 'existing-user' });

        // First call hits DB
        const result1 = await auth.verifyAccountExists('existing-user');
        expect(result1).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);

        // Second call uses cache — no additional DB call
        const result2 = await auth.verifyAccountExists('existing-user');
        expect(result2).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('should re-query DB after cache is invalidated', async () => {
        // Account exists initially
        findUniqueMock.mockResolvedValue({ id: 'user-to-delete' });
        const result1 = await auth.verifyAccountExists('user-to-delete');
        expect(result1).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);

        // Invalidate cache (simulates what should happen on account deletion)
        auth.invalidateAccountCache('user-to-delete');

        // Now account is gone
        findUniqueMock.mockResolvedValue(null);
        const result2 = await auth.verifyAccountExists('user-to-delete');
        expect(result2).toBe(false);
        expect(findUniqueMock).toHaveBeenCalledTimes(2);
    });

    it('should cache non-existence so deleted accounts stay rejected', async () => {
        findUniqueMock.mockResolvedValue(null);

        const result1 = await auth.verifyAccountExists('deleted-user');
        expect(result1).toBe(false);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);

        // Second call — cached as non-existent, no DB hit
        const result2 = await auth.verifyAccountExists('deleted-user');
        expect(result2).toBe(false);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);
    });

    it('should re-query DB after 5-minute TTL expires', async () => {
        findUniqueMock.mockResolvedValue({ id: 'existing-user' });

        const result1 = await auth.verifyAccountExists('existing-user');
        expect(result1).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledTimes(1);

        // Advance time past the 5-minute TTL
        const originalNow = Date.now;
        Date.now = () => originalNow() + 6 * 60 * 1000; // 6 minutes later

        const result2 = await auth.verifyAccountExists('existing-user');
        expect(result2).toBe(true);
        expect(findUniqueMock).toHaveBeenCalledTimes(2);

        // Restore Date.now
        Date.now = originalNow;
    });

    it('rejects a cryptographically valid token when its account no longer exists', async () => {
        findUniqueMock.mockResolvedValue(null);
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({ user: 'deleted-user' });

        await expect(auth.verifyToken('deleted-account-token')).resolves.toBeNull();
    });

    it('rejects a cached token immediately after account-cache invalidation', async () => {
        findUniqueMock.mockResolvedValueOnce({ id: 'user-to-delete' }).mockResolvedValue(null);
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({ user: 'user-to-delete' });

        await expect(auth.verifyToken('cached-deleted-account-token')).resolves.toEqual({
            userId: 'user-to-delete',
            extras: undefined,
            authorizationGeneration: 0,
        });
        auth.invalidateAccountCache('user-to-delete');

        await expect(auth.verifyToken('cached-deleted-account-token')).resolves.toBeNull();
    });

    it('embeds the current account credential generation in newly issued tokens', async () => {
        findUniqueMock.mockResolvedValue({ id: 'versioned-user', authVersion: 3 });
        const generator = (auth as any).tokens.generator;
        generator.new = vi.fn().mockResolvedValue('versioned-token');

        await expect(auth.createToken('versioned-user')).resolves.toBe('versioned-token');
        expect(generator.new).toHaveBeenCalledWith({
            user: 'versioned-user',
            extras: { __idleAuthVersion: 3 },
        });
    });

    it('refuses to mint a token for a suspended account', async () => {
        findUniqueMock.mockResolvedValue({
            id: 'suspended-user',
            authVersion: 4,
            authSuspendedAt: new Date(),
        });
        const generator = (auth as any).tokens.generator;
        generator.new = vi.fn().mockResolvedValue('must-not-be-minted');

        await expect(auth.createToken('suspended-user')).rejects.toMatchObject({
            code: 'ACCOUNT_AUTHENTICATION_UNAVAILABLE',
        });
        expect(generator.new).not.toHaveBeenCalled();
    });

    it('rejects an otherwise valid token from an older credential generation', async () => {
        findUniqueMock.mockResolvedValue({ id: 'versioned-user', authVersion: 2 });
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({
            user: 'versioned-user',
            extras: { __idleAuthVersion: 1 },
        });

        await expect(auth.verifyToken('stale-generation-token')).resolves.toBeNull();
    });

    it('rejects an otherwise current bearer token while its account is suspended', async () => {
        findUniqueMock.mockResolvedValue({
            id: 'suspended-user',
            authVersion: 2,
            authSuspendedAt: new Date(),
        });
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({
            user: 'suspended-user',
            extras: { __idleAuthVersion: 2 },
        });

        await expect(auth.verifyToken('suspended-current-token')).resolves.toBeNull();
    });

    it('keeps legacy unversioned tokens valid only while the account remains at generation zero', async () => {
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({ user: 'legacy-user' });
        findUniqueMock.mockResolvedValueOnce({ id: 'legacy-user', authVersion: 0 });

        await expect(auth.verifyToken('legacy-token-v0')).resolves.toEqual({
            userId: 'legacy-user',
            extras: undefined,
            authorizationGeneration: 0,
        });

        auth.invalidateAccountCache('legacy-user');
        findUniqueMock.mockResolvedValueOnce({ id: 'legacy-user', authVersion: 1 });
        await expect(auth.verifyToken('another-legacy-token')).resolves.toBeNull();
    });

    it('suspends an account while atomically advancing its credential generation', async () => {
        updateManyMock.mockResolvedValue({ count: 1 });
        findUniqueMock.mockResolvedValue({ id: 'revoked-user', authVersion: 1, authSuspendedAt: new Date() });
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({
            user: 'revoked-user',
            extras: { __idleAuthVersion: 0 },
        });

        await expect(auth.suspendUser('revoked-user')).resolves.toEqual({
            found: true,
            invalidatedTokens: 0,
        });

        expect(updateManyMock).toHaveBeenCalledWith({
            where: { id: 'revoked-user' },
            data: {
                authVersion: { increment: 1 },
                authSuspendedAt: expect.any(Date),
            },
        });
        await expect(auth.verifyToken('previously-unknown-token')).resolves.toBeNull();
    });

    it('requires an explicit operator resume before the account can authenticate again', async () => {
        updateManyMock.mockResolvedValue({ count: 1 });

        await expect(auth.resumeUser('suspended-user')).resolves.toBe(true);

        expect(updateManyMock).toHaveBeenCalledWith({
            where: { id: 'suspended-user' },
            data: { authSuspendedAt: null },
        });
    });

    it('rejects a cached token after another relay advances the credential generation', async () => {
        findUniqueMock
            .mockResolvedValueOnce({ id: 'shared-user', authVersion: 0 })
            .mockResolvedValue({ id: 'shared-user', authVersion: 1 });
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({
            user: 'shared-user',
            extras: { __idleAuthVersion: 0 },
        });

        await expect(auth.verifyToken('cross-relay-token')).resolves.toEqual({
            userId: 'shared-user',
            extras: undefined,
            authorizationGeneration: 0,
        });

        // A different relay has advanced Account.authVersion in the database.
        // This process has received no local invalidation signal and still has
        // both the token and prior account state cached.
        await expect(auth.verifyToken('cross-relay-token')).resolves.toBeNull();
        expect(findUniqueMock).toHaveBeenCalledTimes(2);
    });
});

describe('persisted token revocations', () => {
    beforeEach(async () => {
        findUniqueMock.mockReset();
        fsMocks.existsSync.mockClear();
        fsMocks.readFileSync.mockClear();
        fsMocks.writeFileSync.mockReset();
        fsMocks.renameSync.mockReset();
        fsMocks.mkdirSync.mockReset();
        fsMocks.chmodSync.mockReset();
        setRuntimeMasterSecret('a0'.repeat(32));
        delete process.env.DATA_DIR;
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
    });

    it('stores legacy revocation state under the configured durable data directory', async () => {
        process.env.DATA_DIR = '/var/lib/idle-test-data';
        await auth.init();

        auth.revokeToken('token-in-durable-volume');

        expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/var/lib/idle-test-data', {
            recursive: true,
            mode: 0o700,
        });
        expect(fsMocks.renameSync).toHaveBeenCalledWith(
            '/var/lib/idle-test-data/revoked-tokens.json.tmp',
            '/var/lib/idle-test-data/revoked-tokens.json',
        );
    });

    it('should persist revoked token to disk', async () => {
        await auth.init();

        auth.revokeToken('token-to-revoke');

        // Should write tmp file then rename atomically
        expect(fsMocks.mkdirSync).toHaveBeenCalled();
        expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
        expect(fsMocks.renameSync).toHaveBeenCalledTimes(1);

        // Verify the written JSON contains the revoked token
        const writtenJson = fsMocks.writeFileSync.mock.calls[0][1];
        const parsed = JSON.parse(writtenJson);
        expect(parsed.tokens['token-to-revoke']).toBe(Number.MAX_SAFE_INTEGER);
        expect(fsMocks.mkdirSync).toHaveBeenCalledWith(expect.any(String), {
            recursive: true,
            mode: 0o700,
        });
        expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            { mode: 0o600 },
        );
        expect(fsMocks.chmodSync).toHaveBeenCalledWith(expect.any(String), 0o600);
    });

    it('should load revocations from disk on init', async () => {
        const futureExpiry = Date.now() + 1000 * 60 * 60; // 1 hour from now
        configureRevocationFile(JSON.stringify({
            tokens: { 'persisted-revoked-token': futureExpiry },
        }));

        await auth.init();

        // The revoked token should block verification
        const result = await auth.verifyToken('persisted-revoked-token');
        expect(result).toBeNull();
    });

    it('reads an owner-bound regular file through a no-follow descriptor and repairs its mode', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: { 'descriptor-bound-token': Number.MAX_SAFE_INTEGER },
        }), { mode: 0o100644 });

        await auth.init();

        expect(fsMocks.openSync).toHaveBeenCalledWith(
            expect.stringMatching(/revoked-tokens\.json$/),
            fsMocks.constants.O_RDONLY | fsMocks.constants.O_NOFOLLOW,
        );
        expect(fsMocks.fstatSync).toHaveBeenCalledWith(REVOCATION_FD);
        expect(fsMocks.fchmodSync).toHaveBeenCalledWith(REVOCATION_FD, 0o600);
        expect(fsMocks.readSync).toHaveBeenCalledWith(
            REVOCATION_FD,
            expect.any(Buffer),
            expect.any(Number),
            expect.any(Number),
            expect.any(Number),
        );
        expect(fsMocks.readFileSync).not.toHaveBeenCalled();
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
        expect(auth.adminStats().revokedCount).toBe(1);
    });

    it('rejects a revocation file not owned by the server user', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: { 'other-owner-token': Number.MAX_SAFE_INTEGER },
        }), { uid: (process.getuid?.() ?? 0) + 1 });

        await expect(auth.init()).resolves.not.toThrow();

        expect(fsMocks.readSync).not.toHaveBeenCalled();
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('rejects a symlink instead of falling back to a path-based read', async () => {
        const raw = JSON.stringify({
            tokens: { 'symlink-target-token': Number.MAX_SAFE_INTEGER },
        });
        fsMocks.existsSync.mockReturnValue(true);
        fsMocks.readFileSync.mockReturnValue(raw);
        fsMocks.openSync.mockImplementation(() => {
            throw Object.assign(new Error('symlink refused'), { code: 'ELOOP' });
        });

        await expect(auth.init()).resolves.not.toThrow();

        expect(fsMocks.openSync).toHaveBeenCalledWith(
            expect.any(String),
            fsMocks.constants.O_RDONLY | fsMocks.constants.O_NOFOLLOW,
        );
        expect(fsMocks.readFileSync).not.toHaveBeenCalled();
        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('rejects a non-regular revocation file before reading it', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: { 'directory-backed-token': Number.MAX_SAFE_INTEGER },
        }), { isFile: false });

        await expect(auth.init()).resolves.not.toThrow();

        expect(fsMocks.readSync).not.toHaveBeenCalled();
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('rejects an oversized revocation file before allocating or reading it', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: { 'oversized-file-token': Number.MAX_SAFE_INTEGER },
        }), { size: MAX_REVOCATION_FILE_BYTES + 1 });

        await expect(auth.init()).resolves.not.toThrow();

        expect(fsMocks.readSync).not.toHaveBeenCalled();
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('rejects a file that grows after its bounded descriptor size check', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: { 'racing-growth-token': Number.MAX_SAFE_INTEGER },
        }), { trailingByte: true });

        await expect(auth.init()).resolves.not.toThrow();

        expect(auth.adminStats().revokedCount).toBe(0);
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
    });

    it.each([
        ['array token collection', JSON.stringify({ tokens: [] })],
        ['unexpected root field', JSON.stringify({
            tokens: { 'otherwise-valid-token': Number.MAX_SAFE_INTEGER },
            unexpected: true,
        })],
        ['empty token', JSON.stringify({ tokens: { '': Number.MAX_SAFE_INTEGER } })],
        ['oversized token', JSON.stringify({
            tokens: { ['t'.repeat(MAX_PERSISTED_TOKEN_BYTES + 1)]: Number.MAX_SAFE_INTEGER },
        })],
        ['non-numeric marker', JSON.stringify({ tokens: { token: 'revoked' } })],
        ['fractional marker', JSON.stringify({ tokens: { token: 1.5 } })],
        ['negative marker', JSON.stringify({ tokens: { token: -1 } })],
    ])('rejects a revocation file with %s', async (_caseName, raw) => {
        configureRevocationFile(raw);

        await expect(auth.init()).resolves.not.toThrow();

        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('rejects a revocation file whose token count exceeds the bounded map size', async () => {
        const tokens = Object.fromEntries(
            Array.from({ length: MAX_PERSISTED_REVOCATIONS + 1 }, (_, index) => [
                `token-${index}`,
                Number.MAX_SAFE_INTEGER,
            ]),
        );
        configureRevocationFile(JSON.stringify({ tokens }));

        await expect(auth.init()).resolves.not.toThrow();

        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('preserves permanent revocation for every valid legacy numeric marker', async () => {
        configureRevocationFile(JSON.stringify({
            tokens: {
                'past-expiry-token': 1,
                'future-expiry-token': Date.now() + 60_000,
                'permanent-marker-token': Number.MAX_SAFE_INTEGER,
            },
        }));

        await auth.init();

        expect(auth.adminStats().revokedCount).toBe(3);
        for (const token of ['past-expiry-token', 'future-expiry-token', 'permanent-marker-token']) {
            await expect(auth.verifyToken(token)).resolves.toBeNull();
        }
    });

    it('keeps legacy expired entries revoked because persistent tokens do not expire', async () => {
        const pastExpiry = Date.now() - 1000; // already expired
        configureRevocationFile(JSON.stringify({
            tokens: {
                'expired-token': pastExpiry,
            },
        }));

        await auth.init();
        findUniqueMock.mockResolvedValue({ id: 'legacy-user', authVersion: 0 });
        (auth as any).tokens.verifier.verify = vi.fn().mockResolvedValue({ user: 'legacy-user' });

        await expect(auth.verifyToken('expired-token')).resolves.toBeNull();
        expect((auth as any).tokens.verifier.verify).not.toHaveBeenCalled();
    });

    it('should handle corrupted file gracefully', async () => {
        configureRevocationFile('not valid json {{{');

        // Should not throw — starts fresh
        await expect(auth.init()).resolves.not.toThrow();
        expect(auth.adminStats().revokedCount).toBe(0);
        expect(fsMocks.closeSync).toHaveBeenCalledWith(REVOCATION_FD);
    });

    it('should handle file with unexpected format gracefully', async () => {
        configureRevocationFile(JSON.stringify({ unexpected: true }));

        // Should not throw — starts fresh
        await expect(auth.init()).resolves.not.toThrow();
        expect(auth.adminStats().revokedCount).toBe(0);
    });

    it('does not reactivate an old revocation when another token is revoked later', async () => {
        await auth.init();

        // Revoke a token, then advance time past its expiry and revoke another
        auth.revokeToken('first-token');

        const originalNow = Date.now;
        // Advance time far into the future; persistent tokens still require a
        // permanent revocation marker.
        Date.now = () => originalNow() + 31 * 24 * 60 * 60 * 1000;

        auth.revokeToken('second-token');

        // Both tokens remain revoked.
        const lastWriteCall = fsMocks.writeFileSync.mock.calls[fsMocks.writeFileSync.mock.calls.length - 1];
        const parsed = JSON.parse(lastWriteCall[1]);
        expect(parsed.tokens['first-token']).toBe(Number.MAX_SAFE_INTEGER);
        expect(parsed.tokens['second-token']).toBe(Number.MAX_SAFE_INTEGER);

        Date.now = originalNow;
    });

    it('should handle write failure gracefully without throwing', async () => {
        await auth.init();

        fsMocks.writeFileSync.mockImplementation(() => {
            throw new Error('disk full');
        });

        // Should not throw — logs error but continues
        expect(() => auth.revokeToken('token-write-fail')).not.toThrow();
    });

    it('persists every revocation without time-based reactivation', async () => {
        // Seed: load an expired entry from disk on init so we can observe whether
        // it gets swept on each revoke.
        const pastExpiry = Date.now() - 1000;
        configureRevocationFile(JSON.stringify({
            tokens: { 'expired-on-disk': pastExpiry + 1_000_000_000 }, // force "in the past after sweep" later
        }));

        await auth.init();

        // The load filter already drops past-expiry entries. Manually add one
        // to the map to simulate an entry that became expired AFTER init.
        const originalNow = Date.now;
        const T0 = originalNow();
        Date.now = () => T0;

        // Use the public revokeToken API to add a token, then poison its expiry
        // to a past timestamp so we can detect whether the sweep ran.
        auth.revokeToken('soon-to-expire');
        const internal = (auth as any).revokedTokens as Map<string, number>;
        internal.set('soon-to-expire', T0 - 1); // already expired

        // Burst-revoke 3 more tokens within the 60s cooldown window
        Date.now = () => T0 + 10_000; // +10s — well within cooldown
        auth.revokeToken('burst-1');
        Date.now = () => T0 + 20_000;
        auth.revokeToken('burst-2');
        Date.now = () => T0 + 30_000;
        auth.revokeToken('burst-3');

        // Each revoke must persist (crash recovery requirement)
        expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThanOrEqual(4);

        // The manually aged marker remains revoked.
        expect(internal.has('soon-to-expire')).toBe(true);

        // Even far past the former sweep window, a later revoke cannot reactivate it.
        Date.now = () => T0 + 61_000;
        auth.revokeToken('after-cooldown');
        expect(internal.has('soon-to-expire')).toBe(true);

        Date.now = originalNow;
    });
});

describe('token cache TTL + size cap (SEC port from upstream 42822d25)', () => {
    beforeEach(async () => {
        await auth.init();
        findUniqueMock.mockReset().mockResolvedValue({ id: 'user-1', authVersion: 0, authSuspendedAt: null });
        fsMocks.writeFileSync.mockClear();
        fsMocks.existsSync.mockReturnValue(false);
    });

    afterEach(() => {
        auth.shutdown();
    });

    it('expires cache entries past TOKEN_CACHE_TTL_MS and re-verifies', async () => {
        const originalNow = Date.now;
        const T0 = 1_700_000_000_000;
        Date.now = () => T0;

        // Verifier returns a valid user — first call populates cache.
        const verifyMock = vi.fn().mockResolvedValue({ user: 'user-1' });
        (auth as any).tokens.verifier.verify = verifyMock;

        const first = await auth.verifyToken('tok-1');
        expect(first).toEqual({ userId: 'user-1', extras: undefined, authorizationGeneration: 0 });
        expect(verifyMock).toHaveBeenCalledTimes(1);

        // Inside TTL window — cache hit, no re-verify.
        Date.now = () => T0 + (23 * 60 * 60 * 1000);
        const second = await auth.verifyToken('tok-1');
        expect(second).toEqual({ userId: 'user-1', extras: undefined, authorizationGeneration: 0 });
        expect(verifyMock).toHaveBeenCalledTimes(1);

        // Past 24h — cache entry expired, falls through to crypto verify.
        Date.now = () => T0 + (25 * 60 * 60 * 1000);
        const third = await auth.verifyToken('tok-1');
        expect(third).toEqual({ userId: 'user-1', extras: undefined, authorizationGeneration: 0 });
        expect(verifyMock).toHaveBeenCalledTimes(2);

        Date.now = originalNow;
    });

    it('evicts oldest 20% when token cache hits MAX_CACHE_SIZE', async () => {
        const internal = (auth as any).tokenCache as Map<string, unknown>;
        internal.clear();

        // Backfill cache to the cap using cacheToken directly via createToken.
        // createToken funnels through cacheToken, which is what we want to exercise.
        const generatorMock = (auth as any).tokens.generator;
        // Use a counter to produce unique tokens so the cache fills sequentially.
        let counter = 0;
        generatorMock.new = vi.fn(async () => `tok-${counter++}`);

        for (let i = 0; i < 10_000; i++) {
            await auth.createToken(`user-${i}`);
        }
        expect(internal.size).toBe(10_000);

        // One more push triggers eviction: 20% of 10k = 2000 oldest removed,
        // then this entry is inserted → size lands at 8001.
        await auth.createToken('user-10000');
        expect(internal.size).toBe(8001);

        // The oldest evicted token (tok-0) is gone; the latest is present.
        expect(internal.has('tok-0')).toBe(false);
        expect(internal.has('tok-10000')).toBe(true);
    });

    it('cleanup() removes only expired entries and returns the count', async () => {
        const originalNow = Date.now;
        const T0 = 1_700_000_000_000;
        Date.now = () => T0;

        const verifyMock = vi.fn().mockResolvedValue({ user: 'user-1' });
        (auth as any).tokens.verifier.verify = verifyMock;

        await auth.verifyToken('old-token');

        // 23 hours later, insert a fresh entry.
        Date.now = () => T0 + (23 * 60 * 60 * 1000);
        await auth.verifyToken('fresh-token');

        // 25 hours from T0: old-token is expired (cachedAt T0, 25h ago),
        // fresh-token is not (cachedAt T0+23h, only 2h ago).
        Date.now = () => T0 + (25 * 60 * 60 * 1000);
        const removed = auth.cleanup();
        expect(removed).toBe(1);

        const internal = (auth as any).tokenCache as Map<string, unknown>;
        expect(internal.has('old-token')).toBe(false);
        expect(internal.has('fresh-token')).toBe(true);

        Date.now = originalNow;
    });

    it('shutdown() clears the cleanup timer (idempotent)', () => {
        // Timer exists after init.
        expect((auth as any).cleanupTimer).not.toBeNull();
        auth.shutdown();
        expect((auth as any).cleanupTimer).toBeNull();
        // Idempotent — second call is a no-op.
        expect(() => auth.shutdown()).not.toThrow();
    });
});
