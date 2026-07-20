/**
 * Hand-designed session-avatar glyph pack — Northglass terminal aesthetic.
 *
 * Each glyph is a small SVG component rendered inside the AvatarNorthglass canvas. The
 * pack replaces the previous ASCII-on-color avatars that did not match the
 * Northglass visual system.
 *
 * Design principles:
 * - 48x48 viewBox, glyph mass centered visually (not necessarily geometrically — chevrons
 *   feel right slightly left of center for example)
 * - 4-5px stroke weight where stroke-based; solid fills where filled-based
 * - Square line caps (terminal/InfoSec feel — no rounded ends)
 * - Pure geometry, no fonts (so they look identical on iOS / Android / web — the previous
 *   text-glyph approach was font-dependent and rendered differently across platforms)
 * - Each glyph is monochrome — the AvatarNorthglass shell handles bg + fg color choice
 *
 * Families:
 *   Cursors (4) — block, beam, underline, hollow
 *   Prompts (4) — chevron, double-chevron, dollar, hash
 *   Brackets (4) — curly, square, angle, paren
 *   Operators (4) — arrow, pipe, tilde, double-slash
 *   Forms (4) — circle-dot, square-dot, triangle, diamond
 *
 * 20 base glyphs × ~9 brand colors = 180+ unique avatars. Add more glyphs over time to
 * grow the pool without touching the picker or the consumers.
 */

import * as React from 'react';
import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg';

export interface SessionGlyphProps {
    size: number;
    color: string;
}

const VB = 48; // viewBox size — all glyphs draw in 48x48 then scale

// === Cursor family ============================================================

const CursorBlock: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Rect x={12} y={14} width={24} height={26} fill={color} />
    </Svg>
);

const CursorBeam: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Tall narrow bar with subtle serifs top + bottom */}
        <Rect x={21} y={10} width={6} height={28} fill={color} />
        <Rect x={16} y={10} width={16} height={3} fill={color} />
        <Rect x={16} y={35} width={16} height={3} fill={color} />
    </Svg>
);

const CursorUnderline: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Rect x={10} y={32} width={28} height={6} fill={color} />
    </Svg>
);

const CursorHollow: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Rect x={12} y={12} width={24} height={24} stroke={color} strokeWidth={4} fill="none" />
    </Svg>
);

// === Prompt family ============================================================

const PromptChevron: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* > shape as two strokes meeting at point. Off-center left so it doesn't look top-heavy. */}
        <Line x1={16} y1={12} x2={32} y2={24} stroke={color} strokeWidth={5} strokeLinecap="butt" />
        <Line x1={32} y1={24} x2={16} y2={36} stroke={color} strokeWidth={5} strokeLinecap="butt" />
    </Svg>
);

const PromptDoubleChevron: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Line x1={11} y1={14} x2={23} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={23} y1={24} x2={11} y2={34} stroke={color} strokeWidth={4} />
        <Line x1={23} y1={14} x2={35} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={35} y1={24} x2={23} y2={34} stroke={color} strokeWidth={4} />
    </Svg>
);

const PromptDollar: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Geometric S-curve as 3 horizontal bars + 2 connectors. No font dependency. */}
        <Rect x={14} y={12} width={20} height={4} fill={color} />
        <Rect x={14} y={22} width={20} height={4} fill={color} />
        <Rect x={14} y={32} width={20} height={4} fill={color} />
        <Rect x={14} y={16} width={4} height={6} fill={color} />
        <Rect x={30} y={26} width={4} height={6} fill={color} />
        {/* Vertical $ bar through the middle */}
        <Rect x={22} y={8} width={4} height={32} fill={color} />
    </Svg>
);

const PromptHash: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* # as 4 bars, slightly slanted for movement */}
        <Rect x={16} y={10} width={4} height={28} fill={color} />
        <Rect x={28} y={10} width={4} height={28} fill={color} />
        <Rect x={10} y={18} width={28} height={4} fill={color} />
        <Rect x={10} y={28} width={28} height={4} fill={color} />
    </Svg>
);

// === Bracket family ===========================================================

const BracketCurly: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* { } stylized as right-angle brackets with center notch */}
        <Path d="M 18 10 L 14 10 L 14 22 L 10 24 L 14 26 L 14 38 L 18 38" stroke={color} strokeWidth={3} fill="none" />
        <Path d="M 30 10 L 34 10 L 34 22 L 38 24 L 34 26 L 34 38 L 30 38" stroke={color} strokeWidth={3} fill="none" />
    </Svg>
);

const BracketSquare: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Path d="M 20 10 L 14 10 L 14 38 L 20 38" stroke={color} strokeWidth={4} fill="none" />
        <Path d="M 28 10 L 34 10 L 34 38 L 28 38" stroke={color} strokeWidth={4} fill="none" />
    </Svg>
);

const BracketAngle: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* < > facing in — code-block / template indicator */}
        <Line x1={20} y1={14} x2={12} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={12} y1={24} x2={20} y2={34} stroke={color} strokeWidth={4} />
        <Line x1={28} y1={14} x2={36} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={36} y1={24} x2={28} y2={34} stroke={color} strokeWidth={4} />
    </Svg>
);

const BracketParen: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Parens as quarter-arcs */}
        <Path d="M 18 10 Q 10 24 18 38" stroke={color} strokeWidth={4} fill="none" />
        <Path d="M 30 10 Q 38 24 30 38" stroke={color} strokeWidth={4} fill="none" />
    </Svg>
);

// === Operator family ==========================================================

const OpArrowRight: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Long shaft + sharp arrowhead */}
        <Line x1={8} y1={24} x2={34} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={26} y1={16} x2={36} y2={24} stroke={color} strokeWidth={4} />
        <Line x1={36} y1={24} x2={26} y2={32} stroke={color} strokeWidth={4} />
    </Svg>
);

const OpPipe: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Vertical pipe with terminal-bar serifs */}
        <Rect x={22} y={8} width={4} height={32} fill={color} />
        <Rect x={14} y={8} width={20} height={3} fill={color} />
        <Rect x={14} y={37} width={20} height={3} fill={color} />
    </Svg>
);

const OpTilde: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* ~ as a wave drawn with 3 line segments (terminal-y, not cursive) */}
        <Path d="M 10 28 L 18 18 L 30 30 L 38 20" stroke={color} strokeWidth={4} fill="none" />
    </Svg>
);

const OpDoubleSlash: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* // as two diagonal bars */}
        <Line x1={14} y1={36} x2={26} y2={12} stroke={color} strokeWidth={4} />
        <Line x1={22} y1={36} x2={34} y2={12} stroke={color} strokeWidth={4} />
    </Svg>
);

// === Form family ==============================================================

const FormCircleDot: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Circle cx={24} cy={24} r={14} stroke={color} strokeWidth={3} fill="none" />
        <Circle cx={24} cy={24} r={4} fill={color} />
    </Svg>
);

const FormSquareDot: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        <Rect x={10} y={10} width={28} height={28} stroke={color} strokeWidth={3} fill="none" />
        <Rect x={20} y={20} width={8} height={8} fill={color} />
    </Svg>
);

const FormTriangle: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Equilateral triangle pointing right — play/direction feel */}
        <Polygon points="14,10 14,38 36,24" fill={color} />
    </Svg>
);

const FormDiamond: React.FC<SessionGlyphProps> = ({ size, color }) => (
    <Svg width={size} height={size} viewBox={`0 0 ${VB} ${VB}`}>
        {/* Hollow diamond — geometric, security-glyph feel */}
        <Polygon points="24,8 40,24 24,40 8,24" stroke={color} strokeWidth={4} fill="none" />
    </Svg>
);

// === Exported registry ========================================================
// Ordered so the hash → glyph index lookup is stable. Adding new glyphs at the END preserves
// every existing user's avatar — they'll still hash to the same earlier-index glyph.

export const SESSION_GLYPHS: Array<{ name: string; Component: React.FC<SessionGlyphProps> }> = [
    { name: 'cursor-block', Component: CursorBlock },
    { name: 'cursor-beam', Component: CursorBeam },
    { name: 'cursor-underline', Component: CursorUnderline },
    { name: 'cursor-hollow', Component: CursorHollow },
    { name: 'prompt-chevron', Component: PromptChevron },
    { name: 'prompt-double-chevron', Component: PromptDoubleChevron },
    { name: 'prompt-dollar', Component: PromptDollar },
    { name: 'prompt-hash', Component: PromptHash },
    { name: 'bracket-curly', Component: BracketCurly },
    { name: 'bracket-square', Component: BracketSquare },
    { name: 'bracket-angle', Component: BracketAngle },
    { name: 'bracket-paren', Component: BracketParen },
    { name: 'op-arrow-right', Component: OpArrowRight },
    { name: 'op-pipe', Component: OpPipe },
    { name: 'op-tilde', Component: OpTilde },
    { name: 'op-double-slash', Component: OpDoubleSlash },
    { name: 'form-circle-dot', Component: FormCircleDot },
    { name: 'form-square-dot', Component: FormSquareDot },
    { name: 'form-triangle', Component: FormTriangle },
    { name: 'form-diamond', Component: FormDiamond },
];
