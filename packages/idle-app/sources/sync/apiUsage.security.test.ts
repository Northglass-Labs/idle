import { describe, expect, it, vi } from 'vitest';

vi.mock('./apiSocket', () => ({ getIdleClientId: () => 'test-client' }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.example' }));
vi.mock('@/utils/time', () => ({ backoff: (operation: () => unknown) => operation() }));
import {
    calculateTotals,
    getUsageMetricValue,
    UsageQueryParamsSchema,
    UsageResponseSchema,
} from './apiUsage';

const point = {
    timestamp: 1,
    tokens: {
        total: 10,
        input: 4,
        output: 3,
        cache_creation: 2,
        cache_read: 1,
    },
    cost: { total: 1, input: 0.4, output: 0.6 },
    reportCount: 1,
};

describe('usage API contracts', () => {
    it('accepts the canonical bounded response', () => {
        expect(UsageResponseSchema.safeParse({
            usage: [point],
            groupBy: 'hour',
            totalReports: 1,
        }).success).toBe(true);
    });

    it('rejects unknown dimensions, inconsistent totals, and oversized history', () => {
        expect(UsageResponseSchema.safeParse({
            usage: [{ ...point, tokens: { ...point.tokens, attacker: 1 } }],
            groupBy: 'hour',
            totalReports: 1,
        }).success).toBe(false);
        expect(UsageResponseSchema.safeParse({
            usage: [{ ...point, tokens: { ...point.tokens, total: 11 } }],
            groupBy: 'hour',
            totalReports: 1,
        }).success).toBe(false);
        expect(UsageResponseSchema.safeParse({
            usage: Array.from({ length: 1_001 }, (_, index) => ({ ...point, timestamp: index })),
            groupBy: 'day',
            totalReports: 1_000,
        }).success).toBe(false);
        expect(UsageResponseSchema.safeParse({
            usage: [point],
            groupBy: 'hour',
            totalReports: 1,
            attacker: true,
        }).success).toBe(false);
    });

    it('strictly validates the query envelope and time range', () => {
        expect(UsageQueryParamsSchema.safeParse({
            sessionId: 'session-1',
            startTime: 1,
            endTime: 2,
            groupBy: 'hour',
        }).success).toBe(true);
        expect(UsageQueryParamsSchema.safeParse({ startTime: 2, endTime: 1 }).success).toBe(false);
        expect(UsageQueryParamsSchema.safeParse({ attacker: true }).success).toBe(false);
        expect(UsageQueryParamsSchema.safeParse({ sessionId: 'x'.repeat(65) }).success).toBe(false);
    });

    it('does not double-count canonical totals as breakdown dimensions', () => {
        expect(getUsageMetricValue(point, 'tokens')).toBe(10);
        expect(getUsageMetricValue(point, 'cost')).toBe(1);
        expect(calculateTotals([point, point])).toEqual({
            totalTokens: 20,
            totalCost: 2,
            tokensByType: {
                input: 8,
                output: 6,
                cache_creation: 4,
                cache_read: 2,
            },
            costByType: { input: 0.8, output: 1.2 },
        });
    });
});
