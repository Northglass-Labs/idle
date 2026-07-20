import { describe, expect, it } from 'vitest';

import {
    MAX_USAGE_REPORT_DATA_BYTES,
    MAX_USAGE_REPORTS_PER_MINUTE,
    UsageQuerySchema,
    UsageReportDataSchema,
    UsageReportRateLimiter,
} from './usagePolicy';

const canonicalData = {
    tokens: {
        total: 15,
        input: 5,
        output: 4,
        cache_creation: 3,
        cache_read: 3,
    },
    cost: { total: 0.15, input: 0.05, output: 0.10 },
};

describe('usage policy', () => {
    it('requires total tokens to equal the four fixed components', () => {
        expect(UsageReportDataSchema.safeParse(canonicalData).success).toBe(true);
        expect(UsageReportDataSchema.safeParse({
            ...canonicalData,
            tokens: { ...canonicalData.tokens, total: 16 },
        }).success).toBe(false);
    });

    it('keeps the maximum accepted fixed shape below the database byte cap', () => {
        const maximumData = {
            tokens: {
                total: 1_000_000_000,
                input: 1_000_000_000,
                output: 0,
                cache_creation: 0,
                cache_read: 0,
            },
            cost: { total: 1_000_000, input: 1_000_000, output: 1_000_000 },
        };

        expect(UsageReportDataSchema.safeParse(maximumData).success).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(maximumData), 'utf8'))
            .toBeLessThan(MAX_USAGE_REPORT_DATA_BYTES);
    });

    it('allows no more than 60 reports in any rolling minute', () => {
        const limiter = new UsageReportRateLimiter();

        for (let index = 0; index < MAX_USAGE_REPORTS_PER_MINUTE; index += 1) {
            expect(limiter.allow('account-a', 1_000)).toBe(true);
        }
        expect(limiter.allow('account-a', 1_000)).toBe(false);
        expect(limiter.allow('account-a', 60_999)).toBe(false);
        expect(limiter.allow('account-a', 61_000)).toBe(true);
    });

    it('caps account buckets and prunes stale entries before admitting another account', () => {
        const limiter = new UsageReportRateLimiter(2, 60_000);

        expect(limiter.allow('account-a', 0)).toBe(true);
        expect(limiter.allow('account-b', 0)).toBe(true);
        expect(limiter.allow('account-c', 0)).toBe(false);
        expect(limiter.allow('account-c', 60_001)).toBe(true);
    });

    it('does not mint tokens when the wall clock moves backwards', () => {
        const limiter = new UsageReportRateLimiter();
        for (let index = 0; index < MAX_USAGE_REPORTS_PER_MINUTE; index += 1) {
            expect(limiter.allow('account-a', 10_000)).toBe(true);
        }

        expect(limiter.allow('account-a', 5_000)).toBe(false);
        expect(limiter.allow('account-a', 69_999)).toBe(false);
        expect(limiter.allow('account-a', 70_000)).toBe(true);
    });

    it('accepts the UI range and rejects inverted, unknown, or excessive input', () => {
        expect(UsageQuerySchema.safeParse({
            sessionId: 'session-a',
            startTime: 1_700_000_000,
            endTime: 1_800_000_000,
            groupBy: 'day',
        }).success).toBe(true);
        expect(UsageQuerySchema.safeParse({ startTime: 2, endTime: 1 }).success).toBe(false);
        expect(UsageQuerySchema.safeParse({ startTime: Number.MAX_SAFE_INTEGER }).success).toBe(false);
        expect(UsageQuerySchema.safeParse({ attacker: true }).success).toBe(false);
    });
});
