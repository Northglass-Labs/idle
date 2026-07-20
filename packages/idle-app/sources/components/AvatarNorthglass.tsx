import * as React from 'react';
import Svg, { Defs, ClipPath, Rect } from 'react-native-svg';
import { SESSION_GLYPHS } from './sessionAvatarGlyphs/glyphs';
import { pickSessionGlyph } from './sessionAvatarGlyphs/pickSessionGlyph';

/**
 * Northglass-branded session avatar — terminal-themed geometric glyph on a brand-palette
 * background. Renders deterministically from the input `id`, so the same session shows the
 * same avatar on every device + every reload.
 *
 * The hand-drawn SVG pack contains 20 glyphs in five families (cursors, prompts, brackets,
 * operators, and forms) across nine brand background colors. Pure-vector rendering avoids
 * platform font differences and scales consistently on iOS, Android, and web.
 *
 * Pairs visually with ContextEnso (the context indicator) and IdleLogoMark (the brand
 * cursor mark) — all three use the same SVG vocabulary + brand-green palette.
 */

interface AvatarNorthglassProps {
    id: string;
    square?: boolean;
    size?: number;
    monochrome?: boolean;
}

export const AvatarNorthglass = React.memo(function AvatarNorthglass(props: AvatarNorthglassProps) {
    const { id, square, size = 48, monochrome } = props;

    const selection = React.useMemo(
        () => pickSessionGlyph({ seed: id, glyphCount: SESSION_GLYPHS.length }),
        [id]
    );

    // Monochrome variant — used by some surfaces that want grayscale-only avatars.
    // Override bg + fg to fixed grayscale picked from the hash.
    const bg = monochrome
        ? GRAYSCALE_BG[Math.abs(hashSeed(id)) % GRAYSCALE_BG.length]
        : selection.bgColor;
    const fg = monochrome ? '#F5F5F5' : selection.fgColor;

    const { Component: Glyph } = SESSION_GLYPHS[selection.glyphIndex];
    const radius = square ? 0 : size / 2;
    const clipId = `clip-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Defs>
                <ClipPath id={clipId}>
                    <Rect x={0} y={0} width={size} height={size} rx={radius} ry={radius} />
                </ClipPath>
            </Defs>
            <Rect x={0} y={0} width={size} height={size} fill={bg} clipPath={`url(#${clipId})`} />
            <Glyph size={size} color={fg} />
        </Svg>
    );
});

// Grayscale background pool for the monochrome variant. Kept separate from the colored
// pool so monochrome avatars truly read as desaturated.
const GRAYSCALE_BG = ['#0F0F0F', '#1A1A1A', '#2A2A2A', '#3A3A3A', '#4A4A4A', '#6A6A6A'];

function hashSeed(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h = h & h;
    }
    return h;
}
