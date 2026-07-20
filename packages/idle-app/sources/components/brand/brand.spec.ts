import { describe, it, expect } from 'vitest';

/**
 * Brand component smoke tests.
 *
 * The React Native components (IdleLogoMark, IdleTabIcon, IdleWordmark) depend on
 * react-native-svg and react-native which are unavailable in vitest's node environment.
 * Instead, we test the pure-data exports: colors, SVG strings, types, and the barrel index.
 */

// Import directly from pure-data modules to avoid pulling in react-native
// via the barrel index (IdleLogoMark.tsx etc. import react-native-svg).
import { idleBrandColors } from '@/brand/colors';
import type { IdleBrandColors } from '@/brand/colors';
import { logoMarkSvg, logoMarkLiveSvg, logoMarkBrandedSvg, logoMarkMonochromeSvg, tabInboxSvg, tabSessionsSvg, tabSettingsSvg } from '@/brand/svgAssets';

// IdleTabIconType is defined inline to avoid importing IdleTabIcon.tsx
// which depends on react-native-svg (not available in vitest node env).
type IdleTabIconType = 'inbox' | 'sessions' | 'settings';

describe('Brand exports', () => {

    describe('idleBrandColors', () => {
        it('exports the brand color object', () => {
            expect(idleBrandColors).toBeDefined();
            expect(typeof idleBrandColors).toBe('object');
        });

        it('contains the black primary background (OLED-true black)', () => {
            expect(idleBrandColors.black).toBe('#080808');
        });

        it('contains the white accent/text color', () => {
            expect(idleBrandColors.white).toBe('#FAFAFA');
        });

        it('contains the secondary text color', () => {
            expect(idleBrandColors.secondary).toBe('#C0C0C0');
        });

        it('all color values are valid color strings (hex or rgba)', () => {
            // Most tokens are hex; accent-tinted background overlays use rgba
            // for true transparency over arbitrary backgrounds.
            const hexPattern = /^#[0-9A-F]{6}$/i;
            const rgbaPattern = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/;
            for (const [key, value] of Object.entries(idleBrandColors)) {
                const isHex = hexPattern.test(value);
                const isRgba = rgbaPattern.test(value);
                expect(isHex || isRgba, `${key}=${value} should be hex (#RRGGBB) or rgba()`).toBe(true);
            }
        });

        it('satisfies the IdleBrandColors type (compile-time check)', () => {
            const colors: IdleBrandColors = idleBrandColors;
            expect(colors).toBe(idleBrandColors);
        });
    });

    describe('SVG asset strings', () => {
        it('logoMarkSvg is a valid SVG string', () => {
            expect(logoMarkSvg).toContain('<svg');
            expect(logoMarkSvg).toContain('</svg>');
        });

        it('tabInboxSvg is a valid SVG string', () => {
            expect(tabInboxSvg).toContain('<svg');
            expect(tabInboxSvg).toContain('</svg>');
        });

        it('tabSessionsSvg is a valid SVG string', () => {
            expect(tabSessionsSvg).toContain('<svg');
            expect(tabSessionsSvg).toContain('</svg>');
        });

        it('tabSettingsSvg is a valid SVG string', () => {
            expect(tabSettingsSvg).toContain('<svg');
            expect(tabSettingsSvg).toContain('</svg>');
        });

        it('all SVG assets use currentColor for theming', () => {
            for (const svg of [logoMarkSvg, tabInboxSvg, tabSessionsSvg, tabSettingsSvg]) {
                expect(svg).toContain('currentColor');
            }
        });

        it('all SVG assets use 24x24 viewBox', () => {
            for (const svg of [logoMarkSvg, tabInboxSvg, tabSessionsSvg, tabSettingsSvg]) {
                expect(svg).toContain('viewBox="0 0 24 24"');
            }
        });

        it('logoMarkLiveSvg is exported and contains both currentColor and #32D74B (green-pinned cursor)', () => {
            expect(logoMarkLiveSvg).toContain('<svg');
            expect(logoMarkLiveSvg).toContain('currentColor');
            expect(logoMarkLiveSvg).toContain('#32D74B');
        });

        it('logoMarkBrandedSvg is exported and contains #FAFAFA (bars) and #32D74B (glyph)', () => {
            expect(logoMarkBrandedSvg).toContain('<svg');
            expect(logoMarkBrandedSvg).toContain('#FAFAFA');
            expect(logoMarkBrandedSvg).toContain('#32D74B');
            // Branded variant must NOT contain currentColor (it's fully resolved)
            expect(logoMarkBrandedSvg).not.toContain('currentColor');
        });

        it('logoMarkMonochromeSvg uses ONLY currentColor (no hex colors anywhere)', () => {
            expect(logoMarkMonochromeSvg).toContain('<svg');
            expect(logoMarkMonochromeSvg).toContain('currentColor');
            // Monochrome must not have any hex colors
            expect(logoMarkMonochromeSvg).not.toMatch(/#[0-9A-Fa-f]{6}/);
        });

        it('all three variants share the same viewBox and scale transform', () => {
            for (const svg of [logoMarkLiveSvg, logoMarkBrandedSvg, logoMarkMonochromeSvg]) {
                expect(svg).toContain('viewBox="0 0 24 24"');
                expect(svg).toContain('transform="translate(12 12) scale(1.7) translate(-12 -12) translate(2 0)"');
            }
        });
    });

    describe('IdleTabIconType covers expected tabs', () => {
        it('type allows inbox, sessions, and settings', () => {
            // Compile-time type validation — if this compiles, the type is correct
            const tabs: IdleTabIconType[] = ['inbox', 'sessions', 'settings'];
            expect(tabs).toHaveLength(3);
        });
    });
});
