export const MAX_SOCKET_MUTATIONS_PER_MINUTE = 600;
export const SOCKET_MUTATION_RATE_LIMIT_ERROR = 'Socket event rate limit exceeded';

const MUTATING_SOCKET_EVENTS = new Set([
    'machine-alive',
    'machine-update-metadata',
    'machine-update-state',
    'message',
    'session-alive',
    'session-end',
    'update-metadata',
    'update-state',
]);

interface SocketMutationBucket {
    tokens: number;
    lastRefillAt: number;
    lastSeenAt: number;
}

export function isRateLimitedSocketMutationEvent(event: string): boolean {
    return MUTATING_SOCKET_EVENTS.has(event);
}

/**
 * Relay-process-wide token bucket keyed by authenticated account. Every socket
 * for an account shares one mutation budget, so reconnecting or opening sibling
 * sessions cannot multiply the allowed database/cache/event load. Both account
 * cardinality and per-account state are constant-space and fail closed.
 */
export class SocketMutationRateLimiter {
    private readonly buckets = new Map<string, SocketMutationBucket>();

    constructor(
        private readonly capacity = MAX_SOCKET_MUTATIONS_PER_MINUTE,
        private readonly maxBuckets = 10_000,
        private readonly staleAfterMs = 2 * 60_000,
    ) {
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
            throw new Error('Socket mutation capacity must be a positive safe integer');
        }
        if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
            throw new Error('Socket mutation bucket cap must be a positive safe integer');
        }
        if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
            throw new Error('Socket mutation stale interval must cover the refill window');
        }
    }

    allow(accountId: string, now = Date.now()): boolean {
        let bucket = this.buckets.get(accountId);
        if (!bucket) {
            this.prune(now);
            if (this.buckets.size >= this.maxBuckets) return false;
            bucket = {
                tokens: this.capacity,
                lastRefillAt: now,
                lastSeenAt: now,
            };
            this.buckets.set(accountId, bucket);
        }

        const effectiveNow = Math.max(now, bucket.lastSeenAt);
        const elapsedMs = effectiveNow - bucket.lastRefillAt;
        bucket.tokens = Math.min(
            this.capacity,
            bucket.tokens + (elapsedMs * this.capacity / 60_000),
        );
        bucket.lastRefillAt = effectiveNow;
        bucket.lastSeenAt = effectiveNow;

        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }

    clear(): void {
        this.buckets.clear();
    }

    private prune(now: number): void {
        const cutoff = now - this.staleAfterMs;
        for (const [accountId, bucket] of this.buckets) {
            if (bucket.lastSeenAt < cutoff) this.buckets.delete(accountId);
        }
    }
}

export const socketMutationRateLimiter = new SocketMutationRateLimiter();
