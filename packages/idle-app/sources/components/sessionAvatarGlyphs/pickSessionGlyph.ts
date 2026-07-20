/**
 * Pure picker: given an avatar seed string (typically from `getSessionAvatarId`), return
 * the glyph index, background color, and foreground color to render.
 *
 * Independent slices of the hash drive glyph + bg color so visually-similar IDs do not
 * collide on both axes. Foreground color is derived from background luminance so contrast
 * is always readable.
 *
 * Pure / no React Native imports — unit-testable in plain vitest.
 */

// Background palette weighted to brand: 3 dark blacks, 4 greens, 2 mids, 1 accent.
// The 9 colors give ~9 unique bg choices per glyph; combined with 20 glyphs = 180 distinct
// avatars before any duplicates start to form.
export const BG_COLORS: readonly string[] = [
    '#0F0F0F', // near-black (terminal void)
    '#1A1A1A', // deeper grey
    '#2A2A2A', // mid grey
    '#1F4D2A', // deep forest green
    '#28A745', // muted terminal green
    '#32D74B', // primary brand green
    '#5BC862', // light spring green
    '#3A3A3A', // ash grey
    '#FF9500', // amber accent (rare)
] as const;

// Two foreground palettes — light + dark — picked based on bg luminance for contrast.
const FG_LIGHT = '#F5F5F5'; // off-white on dark bg
const FG_DARK = '#0F0F0F';  // deep black on light bg

export interface SessionGlyphSelection {
    glyphIndex: number;   // index into SESSION_GLYPHS
    bgColor: string;
    fgColor: string;
}

function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h = h & h;
    }
    return Math.abs(h);
}

function isLightHex(hex: string): boolean {
    // Standard relative-luminance approximation. Threshold tuned so the brand-primary
    // green (#32D74B) and the muted green (#28A745) both pick the DARK fg — gives the
    // best contrast on those colors.
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.45;
}

export function pickSessionGlyph(args: {
    seed: string;
    glyphCount: number;
}): SessionGlyphSelection {
    const h = hashCode(args.seed);
    // Use distinct hash slices so glyph and bg are independent — adjacent session IDs with
    // similar hashes do not always land on the same pair.
    const glyphIndex = h % args.glyphCount;
    const bgColor = BG_COLORS[Math.floor(h / args.glyphCount) % BG_COLORS.length];
    const fgColor = isLightHex(bgColor) ? FG_DARK : FG_LIGHT;
    return { glyphIndex, bgColor, fgColor };
}
