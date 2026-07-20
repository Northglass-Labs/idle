export const CONNECT_BURST_MAX = 30;
export const CONNECT_BURST_WINDOW_MS = 60_000;
export const CONNECT_GLOBAL_MAX = 3_000;
export const CONNECT_GLOBAL_WINDOW_MS = 60_000;
export const CONNECT_SOURCE_STATE_MAX = 3_000;

interface TokenBucket {
    tokens: number;
    lastRefillAt: number;
}

interface SourceBucket extends TokenBucket {
    lastSeenAt: number;
}

interface ConnectionBurstLimiterOptions {
    perSourceCapacity?: number;
    perSourceWindowMs?: number;
    globalCapacity?: number;
    globalWindowMs?: number;
    maxSources?: number;
    sourceRetentionMs?: number;
    rejectionLogIntervalMs?: number;
    clock?: () => number;
}

function addBounded(value: number): number {
    return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

/** Constant-state token buckets for unauthenticated Socket.IO admission. */
export class ConnectionBurstLimiter {
    private readonly sources = new Map<string, SourceBucket>();
    private readonly global: TokenBucket;
    private readonly perSourceCapacity: number;
    private readonly perSourceWindowMs: number;
    private readonly globalCapacity: number;
    private readonly globalWindowMs: number;
    private readonly maxSources: number;
    private readonly sourceRetentionMs: number;
    private readonly rejectionLogIntervalMs: number;
    private readonly clock: () => number;
    private lastRejectionLogAt: number | null = null;
    private admitted = 0;
    private rejected = 0;

    constructor(options: ConnectionBurstLimiterOptions = {}) {
        this.perSourceCapacity = options.perSourceCapacity ?? CONNECT_BURST_MAX;
        this.perSourceWindowMs = options.perSourceWindowMs ?? CONNECT_BURST_WINDOW_MS;
        this.globalCapacity = options.globalCapacity ?? CONNECT_GLOBAL_MAX;
        this.globalWindowMs = options.globalWindowMs ?? CONNECT_GLOBAL_WINDOW_MS;
        this.maxSources = options.maxSources ?? CONNECT_SOURCE_STATE_MAX;
        this.sourceRetentionMs = options.sourceRetentionMs ?? CONNECT_BURST_WINDOW_MS * 2;
        this.rejectionLogIntervalMs = options.rejectionLogIntervalMs ?? 5_000;
        this.clock = options.clock ?? Date.now;
        this.global = {
            tokens: this.globalCapacity,
            lastRefillAt: this.clock(),
        };
    }

    allow(source: string): boolean {
        const now = this.clock();
        let sourceBucket = this.sources.get(source);
        if (sourceBucket) {
            this.refill(sourceBucket, this.perSourceCapacity, this.perSourceWindowMs, now);
            if (sourceBucket.tokens < 1) return this.deny();
        } else if (this.sources.size >= this.maxSources) {
            return this.deny();
        }

        this.refill(this.global, this.globalCapacity, this.globalWindowMs, now);
        if (this.global.tokens < 1) return this.deny();

        if (!sourceBucket) {
            sourceBucket = {
                tokens: this.perSourceCapacity,
                lastRefillAt: now,
                lastSeenAt: now,
            };
            this.sources.set(source, sourceBucket);
        }

        sourceBucket.tokens -= 1;
        sourceBucket.lastSeenAt = Math.max(sourceBucket.lastSeenAt, now);
        this.global.tokens -= 1;
        this.admitted = addBounded(this.admitted);
        return true;
    }

    prune(): number {
        const now = this.clock();
        let removed = 0;
        for (const [source, bucket] of this.sources) {
            if (now >= bucket.lastSeenAt && now - bucket.lastSeenAt > this.sourceRetentionMs) {
                this.sources.delete(source);
                removed++;
            }
        }
        return removed;
    }

    shouldLogRejection(): boolean {
        const now = this.clock();
        if (
            this.lastRejectionLogAt !== null
            && now >= this.lastRejectionLogAt
            && now - this.lastRejectionLogAt < this.rejectionLogIntervalMs
        ) {
            return false;
        }
        if (this.lastRejectionLogAt !== null && now < this.lastRejectionLogAt) return false;
        this.lastRejectionLogAt = now;
        return true;
    }

    stats(): { sources: number; admitted: number; rejected: number } {
        return { sources: this.sources.size, admitted: this.admitted, rejected: this.rejected };
    }

    inspectSource(source: string): Readonly<SourceBucket> | undefined {
        const bucket = this.sources.get(source);
        return bucket ? { ...bucket } : undefined;
    }

    private deny(): false {
        this.rejected = addBounded(this.rejected);
        return false;
    }

    private refill(bucket: TokenBucket, capacity: number, windowMs: number, now: number): void {
        if (now <= bucket.lastRefillAt) return;
        const elapsed = now - bucket.lastRefillAt;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * capacity / windowMs);
        bucket.lastRefillAt = now;
    }
}

export const connectionBurstLimiter = new ConnectionBurstLimiter();
