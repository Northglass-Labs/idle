import { describe, expect, it } from 'vitest';
import type { Usage } from '../api/types';
import { UsageSchema } from '../claude/types';
import { calculateCost } from './pricing';

const FULL_MILLION_USAGE: Usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
};

describe('calculateCost', () => {
    it.each([
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-opus-4-5',
        'claude-opus-4-8-20260713',
    ])('uses the current Opus pricing for %s', (model) => {
        expect(calculateCost(FULL_MILLION_USAGE, model)).toEqual({
            total: 36.75,
            input: 11.75,
            output: 25,
        });
    });

    it('normalizes case and surrounding whitespace without fuzzy matching', () => {
        expect(calculateCost(FULL_MILLION_USAGE, '  CLAUDE-OPUS-4-8  ')).toEqual({
            total: 36.75,
            input: 11.75,
            output: 25,
        });
    });

    it('uses Sonnet 5 launch pricing through the end of August 2026 UTC', () => {
        expect(calculateCost(
            FULL_MILLION_USAGE,
            'claude-sonnet-5',
            new Date('2026-08-31T23:59:59.999Z'),
        )).toEqual({
            total: 14.7,
            input: 4.7,
            output: 10,
        });
    });

    it('uses Sonnet 5 standard pricing beginning September 1, 2026 UTC', () => {
        expect(calculateCost(
            FULL_MILLION_USAGE,
            'claude-sonnet-5-20260713',
            new Date('2026-09-01T00:00:00.000Z'),
        )).toEqual({
            total: 22.05,
            input: 7.05,
            output: 15,
        });
    });

    it.each([
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
    ])('uses current Sonnet pricing for %s', (model) => {
        expect(calculateCost(FULL_MILLION_USAGE, model)).toEqual({
            total: 22.05,
            input: 7.05,
            output: 15,
        });
    });

    it('uses current Haiku 4.5 pricing', () => {
        expect(calculateCost(FULL_MILLION_USAGE, 'claude-haiku-4-5')).toEqual({
            total: 7.35,
            input: 2.35,
            output: 5,
        });
    });

    it('prices five-minute and one-hour cache writes at their distinct Opus rates', () => {
        expect(calculateCost({
            ...FULL_MILLION_USAGE,
            cache_creation_input_tokens: 2_000_000,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        }, 'claude-opus-4-8')).toEqual({
            total: 46.75,
            input: 21.75,
            output: 25,
        });
    });

    it('applies the Sonnet 5 introductory rate to both cache TTLs', () => {
        expect(calculateCost({
            ...FULL_MILLION_USAGE,
            cache_creation_input_tokens: 2_000_000,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        }, 'claude-sonnet-5', new Date('2026-08-31T23:59:59.999Z'))).toEqual({
            total: 18.7,
            input: 8.7,
            output: 10,
        });
    });

    it.each([
        { model: 'claude-opus-4-8', at: new Date('2026-07-13T00:00:00.000Z'), expected: 10 },
        { model: 'claude-sonnet-4-6', at: new Date('2026-07-13T00:00:00.000Z'), expected: 6 },
        { model: 'claude-sonnet-5', at: new Date('2026-08-31T23:59:59.999Z'), expected: 4 },
        { model: 'claude-sonnet-5', at: new Date('2026-09-01T00:00:00.000Z'), expected: 6 },
        { model: 'claude-haiku-4-5', at: new Date('2026-07-13T00:00:00.000Z'), expected: 2 },
    ])('uses the published one-hour cache rate for $model', ({ model, at, expected }) => {
        expect(calculateCost({
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 0,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 0,
            },
        }, model, at)).toEqual({ total: expected, input: expected, output: 0 });
    });

    it('rejects a cache TTL breakdown that does not equal its aggregate', () => {
        expect(calculateCost({
            ...FULL_MILLION_USAGE,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        }, 'claude-opus-4-8')).toBeNull();
    });

    it.each([
        undefined,
        '',
        'unknown',
        'vendor-opus-4-8',
        'claude-opus-4-80',
        'claude-opus-4-8-unreviewed',
    ])('returns null instead of fabricating a price for %s', (model) => {
        expect(calculateCost(FULL_MILLION_USAGE, model)).toBeNull();
    });
});

describe('UsageSchema cache creation breakdown', () => {
    it('accepts a bounded breakdown equal to the aggregate', () => {
        expect(UsageSchema.safeParse({
            ...FULL_MILLION_USAGE,
            cache_creation_input_tokens: 2_000_000,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        }).success).toBe(true);
    });

    it.each([
        {
            cache_creation_input_tokens: 1_000_000,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        },
        {
            cache_creation_input_tokens: null,
            cache_creation: {
                ephemeral_1h_input_tokens: 0,
                ephemeral_5m_input_tokens: 0,
            },
        },
        {
            cache_creation_input_tokens: 1_000_000_001,
        },
        {
            cache_creation_input_tokens: 1,
            cache_creation: {
                ephemeral_1h_input_tokens: 0,
                ephemeral_5m_input_tokens: 1,
                unreviewed_ttl_input_tokens: 1,
            },
        },
    ])('rejects an inconsistent or unbounded breakdown %#', (cacheFields) => {
        expect(UsageSchema.safeParse({
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            ...cacheFields,
        }).success).toBe(false);
    });

    it('accepts the aggregate-only SDK shape as five-minute cache usage', () => {
        expect(UsageSchema.safeParse({
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: null,
            cache_creation: null,
            service_tier: null,
        }).success).toBe(true);
    });
});
