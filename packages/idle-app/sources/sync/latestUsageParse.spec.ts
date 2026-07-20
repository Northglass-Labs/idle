import { describe, expect, it } from 'vitest';
import { parseLatestUsage, serializeLatestUsage, type LatestUsage } from './latestUsageParse';

const validUsage: LatestUsage = {
    inputTokens: 1200,
    outputTokens: 350,
    cacheCreation: 100,
    cacheRead: 200,
    contextSize: 1850,
    timestamp: 1747584000000,
};

describe('parseLatestUsage', () => {
    it('round-trips a valid usage object', () => {
        const raw = serializeLatestUsage(validUsage);
        expect(parseLatestUsage(raw)).toEqual(validUsage);
    });

    it('returns null for invalid JSON', () => {
        expect(parseLatestUsage('not valid json {{{')).toBeNull();
    });

    it('returns null for an array (not an object)', () => {
        expect(parseLatestUsage('[1, 2, 3]')).toBeNull();
    });

    it('returns null for a primitive', () => {
        expect(parseLatestUsage('42')).toBeNull();
        expect(parseLatestUsage('"hello"')).toBeNull();
        expect(parseLatestUsage('null')).toBeNull();
    });

    it('returns null when a required field is missing', () => {
        const partial = { ...validUsage } as Partial<LatestUsage>;
        delete partial.contextSize;
        expect(parseLatestUsage(JSON.stringify(partial))).toBeNull();
    });

    it('returns null when a required field is the wrong type', () => {
        const bad = { ...validUsage, inputTokens: 'lots' };
        expect(parseLatestUsage(JSON.stringify(bad))).toBeNull();
    });

    it('returns null when contextSize is a string instead of number (regression: real bug shape)', () => {
        const bad = { ...validUsage, contextSize: '1850' };
        expect(parseLatestUsage(JSON.stringify(bad))).toBeNull();
    });

    it('strips unknown extra fields (forward compat)', () => {
        const withExtra = { ...validUsage, futureField: 'whatever', nested: { foo: 1 } };
        const parsed = parseLatestUsage(JSON.stringify(withExtra));
        expect(parsed).toEqual(validUsage);
        expect(parsed).not.toHaveProperty('futureField');
        expect(parsed).not.toHaveProperty('nested');
    });

    it('accepts zero values (a fresh session has 0s, not nulls)', () => {
        const zeros: LatestUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 0,
            timestamp: 0,
        };
        expect(parseLatestUsage(serializeLatestUsage(zeros))).toEqual(zeros);
    });
});

describe('serializeLatestUsage', () => {
    it('produces stable JSON output', () => {
        expect(JSON.parse(serializeLatestUsage(validUsage))).toEqual(validUsage);
    });
});
