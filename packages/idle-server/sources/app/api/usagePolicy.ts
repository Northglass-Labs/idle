import { z } from 'zod';

import { MAX_SESSIONS_PER_ACCOUNT } from '@/app/limits/persistedResourceQuotas';
import { IdSchema } from '@/app/api/routes/_schemas';

export const USAGE_REPORT_KEY = 'claude-session' as const;
export const MAX_USAGE_TOKEN_COUNT = 1_000_000_000;
export const MAX_USAGE_COST = 1_000_000;
export const MAX_USAGE_REPORT_DATA_BYTES = 1_024;
export const MAX_USAGE_REPORTS_PER_MINUTE = 60;
export const MAX_USAGE_REPORTS_PER_QUERY = MAX_SESSIONS_PER_ACCOUNT;
export const MAX_USAGE_QUERY_TIMESTAMP_SECONDS = 253_402_300_799;

export const USAGE_TOKEN_FIELDS = [
    'total',
    'input',
    'output',
    'cache_creation',
    'cache_read',
] as const;
export const USAGE_COST_FIELDS = ['total', 'input', 'output'] as const;

const UsageTokenCountSchema = z.number()
    .finite()
    .int()
    .min(0)
    .max(MAX_USAGE_TOKEN_COUNT);
const UsageCostSchema = z.number()
    .finite()
    .min(0)
    .max(MAX_USAGE_COST);

const UsageTokensSchema = z.object({
    total: UsageTokenCountSchema,
    input: UsageTokenCountSchema,
    output: UsageTokenCountSchema,
    cache_creation: UsageTokenCountSchema,
    cache_read: UsageTokenCountSchema,
}).strict().superRefine((tokens, context) => {
    const componentTotal = tokens.input
        + tokens.output
        + tokens.cache_creation
        + tokens.cache_read;
    if (tokens.total !== componentTotal) {
        context.addIssue({
            code: 'custom',
            message: 'total must equal the token component sum',
            path: ['total'],
        });
    }
});

const UsageCostsSchema = z.object({
    total: UsageCostSchema,
    input: UsageCostSchema,
    output: UsageCostSchema,
}).strict();

export const UsageReportDataSchema = z.object({
    tokens: UsageTokensSchema,
    cost: UsageCostsSchema,
}).strict();

export const UsageReportPayloadSchema = z.object({
    key: z.literal(USAGE_REPORT_KEY),
    sessionId: IdSchema,
    tokens: UsageTokensSchema,
    cost: UsageCostsSchema,
}).strict();

export const UsageQuerySchema = z.object({
    sessionId: IdSchema.nullish(),
    startTime: z.number().finite().int().min(0).max(MAX_USAGE_QUERY_TIMESTAMP_SECONDS).nullish(),
    endTime: z.number().finite().int().min(0).max(MAX_USAGE_QUERY_TIMESTAMP_SECONDS).nullish(),
    groupBy: z.enum(['hour', 'day']).nullish(),
}).strict().superRefine((value, context) => {
    if (
        value.startTime !== null
        && value.startTime !== undefined
        && value.endTime !== null
        && value.endTime !== undefined
        && value.startTime > value.endTime
    ) {
        context.addIssue({
            code: 'custom',
            message: 'startTime must not be after endTime',
            path: ['startTime'],
        });
    }
});

export type UsageReportData = z.infer<typeof UsageReportDataSchema>;

interface UsageRateBucket {
    timestamps: number[];
    lastSeenAt: number;
}

/**
 * One relay-process-wide rolling window keyed by authenticated account. Unlike
 * a per-socket limiter, opening more sockets cannot multiply the write budget.
 * The map and every window are both bounded.
 */
export class UsageReportRateLimiter {
    private readonly buckets = new Map<string, UsageRateBucket>();

    constructor(
        private readonly maxBuckets = 10_000,
        private readonly staleAfterMs = 2 * 60_000,
    ) {
        if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
            throw new Error('Usage rate limiter bucket cap must be a positive safe integer');
        }
        if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
            throw new Error('Usage rate limiter stale interval must cover the rolling window');
        }
    }

    allow(accountId: string, now = Date.now()): boolean {
        let bucket = this.buckets.get(accountId);
        if (!bucket) {
            this.prune(now);
            if (this.buckets.size >= this.maxBuckets) return false;
            bucket = {
                timestamps: [],
                lastSeenAt: now,
            };
            this.buckets.set(accountId, bucket);
        }

        const effectiveNow = Math.max(now, bucket.lastSeenAt);
        const cutoff = effectiveNow - 60_000;
        bucket.timestamps = bucket.timestamps.filter(timestamp => timestamp > cutoff);
        bucket.lastSeenAt = effectiveNow;

        if (bucket.timestamps.length >= MAX_USAGE_REPORTS_PER_MINUTE) return false;
        bucket.timestamps.push(effectiveNow);
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

export const usageReportRateLimiter = new UsageReportRateLimiter();
