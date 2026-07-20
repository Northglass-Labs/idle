import { describe, it, expect } from 'vitest';

// Pure math helpers for the ensō arc — extracted as a separate spec because
// importing the component itself pulls in react-native + react-native-svg
// which can't run under vitest's node env. The component's render path is
// thin; the interesting logic is the ratio + color-tier math which we mirror
// here as a contract test.

function computeFillRatio(usedTokens: number | null, totalTokens: number | null): number {
    const hasData = usedTokens !== null && totalTokens !== null && totalTokens > 0;
    if (!hasData) return 0;
    return Math.min(1, Math.max(0, usedTokens! / totalTokens!));
}

function getFillColorTier(usedRatio: number): 'critical' | 'warning' | 'neutral' {
    // Compare usedRatio directly (not via `1 - usedRatio`) to dodge a float
    // subtraction edge case: 1 - 0.95 = 0.05000...0004, which is > 0.05 so
    // the test for "remaining <= 5%" misclassifies. Compare usedRatio >= X
    // instead. Mirrors the component's exact branching.
    if (usedRatio >= 0.95) return 'critical';
    if (usedRatio >= 0.90) return 'warning';
    return 'neutral';
}

describe('ContextEnso fill math', () => {
    it('returns 0 ratio when usedTokens is null', () => {
        expect(computeFillRatio(null, 200_000)).toBe(0);
    });

    it('returns 0 ratio when totalTokens is null', () => {
        expect(computeFillRatio(50_000, null)).toBe(0);
    });

    it('returns 0 ratio when totalTokens is 0 (avoid divide-by-zero)', () => {
        expect(computeFillRatio(50_000, 0)).toBe(0);
    });

    it('returns correct ratio for normal usage', () => {
        expect(computeFillRatio(100_000, 200_000)).toBeCloseTo(0.5);
    });

    it('clamps ratio to 1 when usedTokens exceeds totalTokens (cache cookies edge)', () => {
        expect(computeFillRatio(250_000, 200_000)).toBe(1);
    });

    it('clamps ratio to 0 when usedTokens is negative (defensive)', () => {
        expect(computeFillRatio(-100, 200_000)).toBe(0);
    });
});

describe('ContextEnso color tiers', () => {
    it('neutral when plenty of context left (10%+ remaining)', () => {
        expect(getFillColorTier(0)).toBe('neutral');     // 100% left
        expect(getFillColorTier(0.5)).toBe('neutral');   // 50% left
        expect(getFillColorTier(0.89)).toBe('neutral');  // 11% left
    });

    it('warning when ≤10% but >5% remaining', () => {
        expect(getFillColorTier(0.90)).toBe('warning');  // 10% left
        expect(getFillColorTier(0.93)).toBe('warning');  // 7% left
    });

    it('critical when ≤5% remaining', () => {
        expect(getFillColorTier(0.95)).toBe('critical'); // 5% left
        expect(getFillColorTier(0.99)).toBe('critical'); // 1% left
        expect(getFillColorTier(1.0)).toBe('critical');  // 0% left
    });
});
