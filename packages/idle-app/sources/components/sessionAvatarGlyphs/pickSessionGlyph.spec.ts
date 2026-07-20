import { describe, it, expect } from 'vitest';
import { pickSessionGlyph, BG_COLORS } from './pickSessionGlyph';

const GLYPH_COUNT = 20;

describe('pickSessionGlyph', () => {
    it('returns a deterministic selection for the same seed (avatar continuity across reconnects)', () => {
        const a = pickSessionGlyph({ seed: 'session-abc:project/x', glyphCount: GLYPH_COUNT });
        const b = pickSessionGlyph({ seed: 'session-abc:project/x', glyphCount: GLYPH_COUNT });
        expect(a).toEqual(b);
    });

    it('returns different selections for two different seeds', () => {
        // The whole point of UI behavior + the new picker — two sessions must visually differ.
        const a = pickSessionGlyph({ seed: 'session-AAA:project/x', glyphCount: GLYPH_COUNT });
        const b = pickSessionGlyph({ seed: 'session-BBB:project/x', glyphCount: GLYPH_COUNT });
        // At least one axis (glyph OR color) must differ — they almost always do, and we
        // accept the tiny collision rate as the cost of pure deterministic hashing.
        const allSame =
            a.glyphIndex === b.glyphIndex &&
            a.bgColor === b.bgColor &&
            a.fgColor === b.fgColor;
        expect(allSame).toBe(false);
    });

    it('glyph index is always within bounds', () => {
        for (let i = 0; i < 200; i++) {
            const sel = pickSessionGlyph({ seed: `session-${i}`, glyphCount: GLYPH_COUNT });
            expect(sel.glyphIndex).toBeGreaterThanOrEqual(0);
            expect(sel.glyphIndex).toBeLessThan(GLYPH_COUNT);
        }
    });

    it('bgColor is always from the brand palette', () => {
        for (let i = 0; i < 200; i++) {
            const sel = pickSessionGlyph({ seed: `session-${i}`, glyphCount: GLYPH_COUNT });
            expect(BG_COLORS).toContain(sel.bgColor);
        }
    });

    it('fgColor is always a contrasting light/dark hex (never the same as bg)', () => {
        for (let i = 0; i < 200; i++) {
            const sel = pickSessionGlyph({ seed: `session-${i}`, glyphCount: GLYPH_COUNT });
            expect(sel.fgColor).toMatch(/^#[0-9A-F]{6}$/i);
            expect(sel.fgColor.toLowerCase()).not.toBe(sel.bgColor.toLowerCase());
        }
    });

    it('terminal-green primary bg (#32D74B) pairs with dark fg for contrast', () => {
        // Find a seed that hashes to the primary green so we can verify the contrast logic.
        // Brute-force a few hundred seeds until one lands on it.
        let found = false;
        for (let i = 0; i < 500; i++) {
            const sel = pickSessionGlyph({ seed: `seed-${i}`, glyphCount: GLYPH_COUNT });
            if (sel.bgColor === '#32D74B') {
                expect(sel.fgColor).toBe('#0F0F0F');
                found = true;
                break;
            }
        }
        expect(found, 'expected at least one seed to land on #32D74B in 500 samples').toBe(true);
    });

    it('near-black bg (#0F0F0F) pairs with light fg for contrast', () => {
        let found = false;
        for (let i = 0; i < 500; i++) {
            const sel = pickSessionGlyph({ seed: `seed-${i}`, glyphCount: GLYPH_COUNT });
            if (sel.bgColor === '#0F0F0F') {
                expect(sel.fgColor).toBe('#F5F5F5');
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });

    it('distributes glyphs reasonably evenly across the pool', () => {
        // Not a strict uniformity test — just a sanity check that the hash isn't degenerate
        // (e.g., every seed picking glyph 0). Run 500 seeds, expect at least half the glyphs
        // to appear at least once.
        const seen = new Set<number>();
        for (let i = 0; i < 500; i++) {
            const sel = pickSessionGlyph({ seed: `seed-distribution-${i}`, glyphCount: GLYPH_COUNT });
            seen.add(sel.glyphIndex);
        }
        expect(seen.size).toBeGreaterThanOrEqual(GLYPH_COUNT / 2);
    });

    it('handles empty seed without crashing', () => {
        const sel = pickSessionGlyph({ seed: '', glyphCount: GLYPH_COUNT });
        expect(sel.glyphIndex).toBeGreaterThanOrEqual(0);
        expect(sel.glyphIndex).toBeLessThan(GLYPH_COUNT);
    });
});
