/**
 * Idle brand SVG strings for use with SvgXml.
 *
 * Three variants are exported:
 *   - logoMarkLiveSvg      — in-app render. Bars + chevron use currentColor (parent themes them);
 *                            the cursor is pinned to #32D74B (the "alive" signature).
 *   - logoMarkBrandedSvg   — baked PNG source. Hardcoded white bars + green glyph on dark bg.
 *                            Used by the icon/favicon/social-card PNG generation script.
 *   - logoMarkMonochromeSvg — single-color silhouette. Used for Android themed icon, iOS 18 Tinted,
 *                             and any context where a single brand color is required.
 *
 * Geometry: 24×24 viewBox. Bars at y=3 and y=20.1 (height 0.9). Glyph group scaled 1.7× and
 * recentered via the transform on the inner <g>. Chevron + cursor get stroke-width 0.1 on top
 * of fill for a +10% silhouette dilation that preserves the brush character.
 *
 * `logoMarkSvg` is a back-compat alias for the Live variant so existing imports keep working.
 */

const BAR_TOP    = `<rect x="2" y="3" width="20" height="0.9" rx="0.45" fill="__FILL__"/>`;
const BAR_BOTTOM = `<rect x="2" y="20.1" width="20" height="0.9" rx="0.45" fill="__FILL__"/>`;
const CHEVRON_D  = `M6.5 9.5 C6.7 9.3 7 9.3 7.5 9.7 C8.3 10.3 9.2 11 10 11.8 C10.3 12 10.4 12.1 10.2 12.2 C9.6 12.7 8.6 13.5 7.8 14.1 C7.2 14.5 6.8 14.7 6.6 14.5 C6.5 14.3 6.6 14.1 7.2 13.6 C8 13 8.8 12.4 9.5 12 C8.8 11.6 8 11 7.2 10.4 C6.6 9.9 6.5 9.7 6.5 9.5 Z`;
const CURSOR_D   = `M12.8 10.2 C12.9 10 13 10 13.1 10.2 C13.2 10.5 13.3 11 13.3 12 C13.3 13 13.2 13.5 13.1 13.8 C13 14 12.9 14 12.8 13.8 C12.7 13.5 12.6 13 12.6 12 C12.6 11 12.7 10.5 12.8 10.2 Z`;
const TRANSFORM  = `translate(12 12) scale(1.7) translate(-12 -12) translate(2 0)`;

function buildLogoSvg(opts: { barFill: string; chevronFill: string; cursorFill: string }): string {
    const { barFill, chevronFill, cursorFill } = opts;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">`
        + BAR_TOP.replace('__FILL__', barFill)
        + BAR_BOTTOM.replace('__FILL__', barFill)
        + `<g transform="${TRANSFORM}">`
        + `<path d="${CHEVRON_D}" fill="${chevronFill}" stroke="${chevronFill}" stroke-width="0.1" stroke-linejoin="round"/>`
        + `<path d="${CURSOR_D}" fill="${cursorFill}" stroke="${cursorFill}" stroke-width="0.1" stroke-linejoin="round"/>`
        + `</g></svg>`;
}

/** In-app render: bars + chevron tint to currentColor; cursor pinned to brand green. */
export const logoMarkLiveSvg = buildLogoSvg({
    barFill: 'currentColor',
    chevronFill: 'currentColor',
    cursorFill: '#32D74B',
});

/** Baked-PNG render: hardcoded brand colors. White bars + green glyph on dark bg. */
export const logoMarkBrandedSvg = buildLogoSvg({
    barFill: '#FAFAFA',
    chevronFill: '#32D74B',
    cursorFill: '#32D74B',
});

/** Single-color silhouette: everything is currentColor. */
export const logoMarkMonochromeSvg = buildLogoSvg({
    barFill: 'currentColor',
    chevronFill: 'currentColor',
    cursorFill: 'currentColor',
});

/** Back-compat alias. Existing IdleLogoMark and tests import this. Same SVG as Live. */
export const logoMarkSvg = logoMarkLiveSvg;

/** Inbox / tray icon. 24×24. */
export const tabInboxSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z"/><path d="M4 8l2.5-4h11L20 8"/><path d="M9 13h6"/></svg>`;

/** Sessions / list icon. 24×24. */
export const tabSessionsSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10"/><path d="M7 13h6"/></svg>`;

/** Settings / gear icon. 24×24. */
export const tabSettingsSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M18.36 5.64l1.41-1.41"/></svg>`;
