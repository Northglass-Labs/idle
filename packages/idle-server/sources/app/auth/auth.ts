import * as fs from "fs";
import * as path from "path";
import * as privacyKit from "privacy-kit";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { getRuntimeMasterSecret } from "@/utils/runtimeMasterSecret";

interface TokenCacheEntry {
    userId: string;
    extras?: any;
    authVersion: number;
    cachedAt: number;
}

export interface VerifiedCredential {
    userId: string;
    extras?: any;
    authorizationGeneration: number;
}

interface AccountCacheEntry {
    exists: boolean;
    authVersion: number;
    authSuspended: boolean;
    cachedAt: number;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
}

// Tokens signed by privacy-kit are persistent, so a per-token revocation must
// also be permanent. Number.MAX_SAFE_INTEGER keeps the existing on-disk shape
// backward compatible while eliminating time-based credential reactivation.
const PERMANENT_REVOCATION_MARKER = Number.MAX_SAFE_INTEGER;
// Account cache TTL: 5 minutes
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
function revocationFilePath(): string {
    const dataDirectory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data');
    return path.resolve(dataDirectory, 'revoked-tokens.json');
}
// Token cache TTL: 24h. Re-verify cryptographically after expiry. Tokens
// themselves are persistent and never expire — this only bounds cache
// freshness so a deliberately-revoked-then-re-issued-with-same-payload
// situation can't be papered over by a stale cache.
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Hard cap on the in-memory token cache. At ~150 bytes/entry × 10k =
// ~1.5MB upper bound. Prevents unbounded growth in long-running servers.
const TOKEN_CACHE_MAX_SIZE = 10_000;
// LRU-style eviction: when cap hit, evict the oldest 20% in insertion
// order. JS Map preserves insertion order on iteration so the first N
// entries are the oldest. Burst-eviction keeps amortized cost low vs
// evicting one entry per insertion.
const TOKEN_CACHE_EVICT_FRACTION = 0.20;
// How often to sweep expired token-cache entries. 10 min is well under
// the 24h TTL so an entry's wall-clock lifetime caps near TTL+10min.
const TOKEN_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const AUTH_VERSION_CLAIM = '__idleAuthVersion';
// The revocation file is a legacy compatibility path, not a general-purpose
// credential database. Keep startup work and memory allocation tightly bounded.
const MAX_REVOCATION_FILE_BYTES = 1024 * 1024;
const MAX_PERSISTED_REVOCATIONS = 10_000;
// Matches the public client credential boundary.
const MAX_PERSISTED_TOKEN_BYTES = 16 * 1024;
const ACCOUNT_AUTHENTICATION_UNAVAILABLE = 'ACCOUNT_AUTHENTICATION_UNAVAILABLE';

class AccountAuthenticationUnavailableError extends Error {
    readonly code = ACCOUNT_AUTHENTICATION_UNAVAILABLE;

    constructor() {
        super('Account authentication is unavailable');
        this.name = 'AccountAuthenticationUnavailableError';
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePersistedRevocations(raw: string): Map<string, number> {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed) || Object.keys(parsed).length !== 1 || !isPlainRecord(parsed.tokens)) {
        throw new Error('Unexpected revocation file shape');
    }

    const entries = Object.entries(parsed.tokens);
    if (entries.length > MAX_PERSISTED_REVOCATIONS) {
        throw new Error('Revocation entry limit exceeded');
    }

    const revocations = new Map<string, number>();
    for (const [token, marker] of entries) {
        if (
            token.length === 0
            || Buffer.byteLength(token, 'utf8') > MAX_PERSISTED_TOKEN_BYTES
            || typeof marker !== 'number'
            || !Number.isSafeInteger(marker)
            || marker <= 0
        ) {
            throw new Error('Invalid revocation entry');
        }

        // Legacy files stored expiry timestamps. The bearer tokens themselves
        // never expired, so every valid numeric marker remains permanent.
        revocations.set(token, PERMANENT_REVOCATION_MARKER);
    }

    return revocations;
}

function readBoundedRevocationFile(): string {
    const revocationFile = revocationFilePath();
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!Number.isInteger(noFollow) || noFollow === 0) {
        throw new Error('No-follow file opens are unavailable');
    }

    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(revocationFile, fs.constants.O_RDONLY | noFollow);
        const stat = fs.fstatSync(descriptor);
        if (
            !stat.isFile()
            || !Number.isSafeInteger(stat.size)
            || stat.size < 0
            || stat.size > MAX_REVOCATION_FILE_BYTES
        ) {
            throw new Error('Revocation file is not a bounded regular file');
        }

        const currentUid = process.getuid?.();
        if (currentUid !== undefined && stat.uid !== currentUid) {
            throw new Error('Revocation file is not owned by the server user');
        }

        // Repair permissive legacy modes through the verified descriptor, never
        // by pathname after the security checks.
        if ((stat.mode & 0o077) !== 0) {
            fs.fchmodSync(descriptor, 0o600);
        }

        const contents = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < contents.length) {
            const bytesRead = fs.readSync(
                descriptor,
                contents,
                offset,
                contents.length - offset,
                offset,
            );
            if (bytesRead <= 0 || bytesRead > contents.length - offset) {
                throw new Error('Revocation file changed while reading');
            }
            offset += bytesRead;
        }

        // A positioned one-byte probe prevents a file-growth race from turning
        // the fstat check into an unbounded or silently truncated read.
        const trailingByte = Buffer.allocUnsafe(1);
        if (fs.readSync(descriptor, trailingByte, 0, 1, stat.size) !== 0) {
            throw new Error('Revocation file changed while reading');
        }

        return contents.toString('utf8');
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private accountCache = new Map<string, AccountCacheEntry>();
    private revokedTokens = new Map<string, number>(); // token -> permanent marker
    private tokens: AuthTokens | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    async init(): Promise<void> {
        // Reset state for re-initialization (supports testing and config reload)
        this.tokens = null;
        this.tokenCache.clear();
        this.accountCache.clear();
        this.revokedTokens.clear();
        // Stop any prior timer so re-init doesn't leak intervals.
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        log({ module: 'auth' }, 'Initializing auth module...');

        // Load persisted revocations from disk
        this.loadRevocations();

        const masterSecret = getRuntimeMasterSecret();

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'idle',
            seed: masterSecret,
        });


        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'idle',
            publicKey: Uint8Array.from(generator.publicKey)
        });

        this.tokens = { generator, verifier };

        // Start periodic cleanup of expired token-cache entries. Long-running
        // servers without this grow tokenCache unboundedly across reconnects.
        this.cleanupTimer = setInterval(
            () => this.cleanup(),
            TOKEN_CACHE_CLEANUP_INTERVAL_MS
        );
        // Allow Node to exit if this is the only thing keeping the loop alive
        // (e.g. test teardown where init() ran but shutdown wasn't called).
        this.cleanupTimer.unref?.();

        log({ module: 'auth' }, 'Auth module initialized');
    }

    // For tests + graceful shutdown. Idempotent.
    shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        // Token issuance is rare and must observe the authoritative generation:
        // using a cached value here could mint an already-stale token immediately
        // after an operator revocation in another process.
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { id: true, authVersion: true, authSuspendedAt: true },
        });
        if (!account || account.authSuspendedAt != null) {
            throw new AccountAuthenticationUnavailableError();
        }
        const authVersion = account.authVersion;
        this.accountCache.set(userId, {
            exists: true,
            authVersion,
            authSuspended: false,
            cachedAt: Date.now(),
        });

        const payload: any = {
            user: userId,
            extras: {
                ...(extras ?? {}),
                [AUTH_VERSION_CLAIM]: authVersion,
            },
        };

        const token = await this.tokens.generator.new(payload);

        // Cache the token immediately (size-capped, LRU-evicted)
        this.cacheToken(token, { userId, extras, authVersion, cachedAt: Date.now() });

        return token;
    }

    async verifyToken(token: string): Promise<VerifiedCredential | null> {
        // Check revocation list first
        if (this.revokedTokens.has(token)) {
            return null;
        }

        // Check cache (with TTL — expired entries fall through to crypto verify)
        const cached = this.tokenCache.get(token);
        if (cached) {
            if (Date.now() - cached.cachedAt > TOKEN_CACHE_TTL_MS) {
                this.tokenCache.delete(token);
            } else {
                if (!await this.isCredentialVersionCurrent(cached.userId, cached.authVersion)) {
                    this.tokenCache.delete(token);
                    return null;
                }
                return {
                    userId: cached.userId,
                    extras: cached.extras,
                    authorizationGeneration: cached.authVersion,
                };
            }
        }

        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }

            const userId = verified.user;
            if (typeof userId !== 'string' || userId.length === 0) {
                return null;
            }
            const verifiedExtras = verified.extras;
            const rawAuthVersion: unknown = verifiedExtras?.[AUTH_VERSION_CLAIM];
            let authVersion: number;
            if (rawAuthVersion === undefined) {
                authVersion = 0;
            } else if (
                typeof rawAuthVersion !== 'number'
                || !Number.isSafeInteger(rawAuthVersion)
                || rawAuthVersion < 0
            ) {
                return null;
            } else {
                authVersion = rawAuthVersion;
            }
            const extras = verifiedExtras && typeof verifiedExtras === 'object'
                ? Object.fromEntries(Object.entries(verifiedExtras).filter(([key]) => key !== AUTH_VERSION_CLAIM))
                : undefined;
            const publicExtras = extras && Object.keys(extras).length > 0 ? extras : undefined;

            // Persistent bearer signatures remain cryptographically valid after
            // an account is deleted. Bind every cache hit/miss to current tenant
            // existence so deletion immediately removes authorization too.
            if (!await this.isCredentialVersionCurrent(userId, authVersion)) {
                this.tokenCache.delete(token);
                return null;
            }

            // Cache the result with size cap + LRU eviction
            this.cacheToken(token, { userId, extras: publicExtras, authVersion, cachedAt: Date.now() });

            return { userId, extras: publicExtras, authorizationGeneration: authVersion };

        } catch {
            log({ module: 'auth', level: 'error' }, 'Token verification failed');
            return null;
        }
    }

    // Insert into tokenCache, evicting the oldest 20% in insertion order
    // when the cap is hit. JS Map iterates in insertion order so the first
    // N keys are the oldest. Bulk-evicting amortizes the cost across many
    // future inserts.
    private cacheToken(token: string, entry: TokenCacheEntry): void {
        if (this.tokenCache.size >= TOKEN_CACHE_MAX_SIZE) {
            const evictCount = Math.ceil(TOKEN_CACHE_MAX_SIZE * TOKEN_CACHE_EVICT_FRACTION);
            const keysToEvict: string[] = [];
            let i = 0;
            for (const key of this.tokenCache.keys()) {
                if (i >= evictCount) break;
                keysToEvict.push(key);
                i++;
            }
            for (const key of keysToEvict) {
                this.tokenCache.delete(key);
            }
            log(
                { module: 'auth', evictedCount: evictCount },
                'Token cache reached capacity; evicted oldest entries'
            );
        }
        this.tokenCache.set(token, entry);
    }

    invalidateUserTokens(userId: string): number {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        let invalidated = 0;
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
                invalidated++;
            }
        }

        log({ module: 'auth' }, 'Invalidated cached tokens for account');
        return invalidated;
    }

    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }

    // Operator kill-switch: atomically suspend account authentication and
    // advance the bearer generation. Suspension also blocks the durable account
    // signing credential from immediately minting a replacement token.
    async suspendUser(userId: string): Promise<{ found: boolean; invalidatedTokens: number }> {
        const suspended = await db.account.updateMany({
            where: { id: userId },
            data: {
                authVersion: { increment: 1 },
                authSuspendedAt: new Date(),
            },
        });
        const invalidated = this.invalidateUserTokens(userId);
        this.accountCache.delete(userId);
        log({ module: 'auth' }, 'Operator suspended account authentication');
        return {
            found: suspended.count === 1,
            invalidatedTokens: invalidated,
        };
    }

    // Suspension never clears implicitly. Only the operator-only enable route
    // calls this method; pre-suspension bearer tokens stay stale because their
    // generation was advanced by suspendUser().
    async resumeUser(userId: string): Promise<boolean> {
        const resumed = await db.account.updateMany({
            where: { id: userId },
            data: { authSuspendedAt: null },
        });
        this.accountCache.delete(userId);
        log({ module: 'auth' }, 'Operator enabled account authentication');
        return resumed.count === 1;
    }

    // Lightweight stats for the admin panel.
    adminStats(): { tokenCacheSize: number; revokedCount: number } {
        return { tokenCacheSize: this.tokenCache.size, revokedCount: this.revokedTokens.size };
    }

    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }

        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }

        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }

    private async getAccountAuthorizationState(userId: string): Promise<AccountCacheEntry> {
        const cached = this.accountCache.get(userId);
        if (cached && (Date.now() - cached.cachedAt) < ACCOUNT_CACHE_TTL_MS) {
            return cached;
        }

        return this.getAuthoritativeAccountAuthorizationState(userId);
    }

    private async getAuthoritativeAccountAuthorizationState(userId: string): Promise<AccountCacheEntry> {
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { id: true, authVersion: true, authSuspendedAt: true },
        });

        const exists = Boolean(account);
        const state = {
            exists,
            authVersion: account?.authVersion ?? 0,
            authSuspended: account?.authSuspendedAt != null,
            cachedAt: Date.now(),
        };
        this.accountCache.set(userId, state);
        return state;
    }

    private async isCredentialVersionCurrent(userId: string, authVersion: number): Promise<boolean> {
        // Authorization decisions must not rely on process-local account state:
        // another relay can delete the account or advance authVersion without a
        // local invalidation signal. Token signature results remain cached, but
        // tenant existence and credential generation are checked authoritatively.
        const account = await this.getAuthoritativeAccountAuthorizationState(userId);
        return account.exists && !account.authSuspended && account.authVersion === authVersion;
    }

    async isAuthorizationGenerationCurrent(userId: string, authVersion: number): Promise<boolean> {
        return this.isCredentialVersionCurrent(userId, authVersion);
    }

    // Verify that an account exists in the database, with caching
    async verifyAccountExists(userId: string): Promise<boolean> {
        return (await this.getAccountAuthorizationState(userId)).exists;
    }

    // Invalidate the account existence cache for a specific user
    invalidateAccountCache(userId: string): void {
        this.accountCache.delete(userId);
    }

    // Revoke a token, persisting to disk for crash recovery
    revokeToken(token: string): void {
        this.revokedTokens.set(token, PERMANENT_REVOCATION_MARKER);
        // Also remove from token cache so it fails immediately
        this.tokenCache.delete(token);
        this.persistRevocations();
    }

    // Load revocations from disk on startup
    private loadRevocations(): void {
        try {
            const revocations = parsePersistedRevocations(readBoundedRevocationFile());
            for (const [token, marker] of revocations) {
                this.revokedTokens.set(token, marker);
            }

            log({ module: 'auth', loadedCount: this.revokedTokens.size }, 'Loaded revoked tokens');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                log(
                    { module: 'auth', level: 'error' },
                    'Failed to load revocations: file is unsafe, oversized, or malformed',
                );
            }
        }
    }

    // Persist to disk atomically (write tmp + rename) with owner-only modes.
    private persistRevocations(): void {
        try {
            const revocationFile = revocationFilePath();
            const dir = path.dirname(revocationFile);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

            const tokens: Record<string, number> = {};
            for (const [token, expiry] of this.revokedTokens.entries()) {
                tokens[token] = expiry;
            }

            const tmpFile = revocationFile + '.tmp';
            fs.writeFileSync(tmpFile, JSON.stringify({ tokens }), { mode: 0o600 });
            fs.chmodSync(tmpFile, 0o600);
            fs.renameSync(tmpFile, revocationFile);
            fs.chmodSync(revocationFile, 0o600);
        } catch {
            log({ module: 'auth', level: 'error' }, 'Failed to persist token revocations');
        }
    }

    // Periodic sweep: delete tokenCache entries past their TTL.
    // Fired by setInterval from init(); also exported so tests can drive it.
    cleanup(): number {
        const now = Date.now();
        let removed = 0;
        for (const [token, entry] of this.tokenCache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
                this.tokenCache.delete(token);
                removed++;
            }
        }
        if (removed > 0) {
            log(
                { module: 'auth', removedCount: removed, remainingCount: this.tokenCache.size },
                'Removed expired token cache entries'
            );
        }
        return removed;
    }
}

// Global instance
export const auth = new AuthModule();
