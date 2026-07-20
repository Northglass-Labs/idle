import { describe, it, expect } from 'vitest';
import { buildContextEnsoSheetContent } from './contextEnsoSheetContent';

describe('buildContextEnsoSheetContent', () => {
    describe('no-data branch (used = null or 0)', () => {
        it('returns no-data shape when usedTokens is null', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: null, totalTokens: 200_000, model: 'claude-opus-4-7' });
            expect(c.kind).toBe('no-data');
            if (c.kind === 'no-data') {
                expect(c.modelLine).toBeNull();
                expect(c.showTip).toBe(false);
                expect(c.rows).toHaveLength(2);
                expect(c.rows[0]).toEqual({ label: 'Window', value: '200,000 tokens', mono: true });
                expect(c.rows[1]).toEqual({ label: 'Model', value: 'claude-opus-4-7', mono: true });
            }
        });

        it('returns no-data shape when usedTokens is 0', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 0, totalTokens: 1_000_000, model: 'claude-sonnet-4-6' });
            expect(c.kind).toBe('no-data');
        });

        it('falls back to "unknown model" label when model is null/undefined/"unknown"', () => {
            for (const m of [null, undefined, 'unknown']) {
                const c = buildContextEnsoSheetContent({ usedTokens: null, totalTokens: 200_000, model: m });
                if (c.kind === 'no-data') expect(c.rows[1].value).toBe('unknown model');
            }
        });
    });

    describe('data branch (used > 0)', () => {
        it('formats 84,213 of 200,000 as "42% used" with normal tier', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 84213, totalTokens: 200_000, model: 'claude-haiku-4-5' });
            expect(c.kind).toBe('data');
            if (c.kind === 'data') {
                expect(c.percentText).toBe('42% used');
                expect(c.percentTier).toBe('normal');
                expect(c.modelLine).toBe('claude-haiku-4-5 · 200k');
                expect(c.rows).toEqual([
                    { label: 'Used', value: '84,213 tokens', mono: true },
                    { label: 'Remaining', value: '115,787 tokens', mono: true },
                    { label: 'Window', value: '200,000 tokens', mono: true },
                ]);
                expect(c.showTip).toBe(true);
            }
        });

        it('flips to warning tier at exactly 90% used', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 180_000, totalTokens: 200_000, model: 'claude-haiku-4-5' });
            if (c.kind === 'data') expect(c.percentTier).toBe('warning');
        });

        it('flips to critical tier at exactly 95% used', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 190_000, totalTokens: 200_000, model: 'claude-haiku-4-5' });
            if (c.kind === 'data') expect(c.percentTier).toBe('critical');
        });

        it('clamps over-100% usage (cache-cookie edge) to 100% rather than showing negative remaining', () => {
            // Real-world: prompt caching can inflate "tokens" temporarily above the window.
            // We render 100% / 0 remaining instead of -10% / -25k tokens which would scare users.
            const c = buildContextEnsoSheetContent({ usedTokens: 220_000, totalTokens: 200_000, model: 'claude-haiku-4-5' });
            if (c.kind === 'data') {
                expect(c.percentText).toBe('100% used');
                expect(c.percentTier).toBe('critical');
                expect(c.rows[1].value).toBe('0 tokens'); // Remaining row
            }
        });

        it('formats 1M window correctly in modelLine (whole-number M)', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 500_000, totalTokens: 1_000_000, model: 'claude-opus-4-7' });
            if (c.kind === 'data') expect(c.modelLine).toBe('claude-opus-4-7 · 1M');
        });

        it('formats 200k window correctly in modelLine (whole-number k)', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 50_000, totalTokens: 200_000, model: 'claude-haiku-4-5' });
            if (c.kind === 'data') expect(c.modelLine).toBe('claude-haiku-4-5 · 200k');
        });

        it('formats fractional M as 1.5M etc.', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 100_000, totalTokens: 1_500_000, model: 'some-future-model' });
            if (c.kind === 'data') expect(c.modelLine).toBe('some-future-model · 1.5M');
        });

        it('renders unknown model gracefully when CLI hasn\'t sent currentModelCode yet', () => {
            const c = buildContextEnsoSheetContent({ usedTokens: 12345, totalTokens: 1_000_000, model: null });
            if (c.kind === 'data') expect(c.modelLine).toBe('unknown model · 1M');
        });
    });
});
