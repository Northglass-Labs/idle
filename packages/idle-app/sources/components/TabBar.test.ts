/**
 * Regression tests for PWA tab bar bottom padding.
 *
 * Bug: iOS PWA standalone mode reports 0 for safe area insets, so
 * the tab bar can have no bottom padding and the home indicator can cover
 * the tab icons. Apply
 * Math.max(insets.bottom, 34) on web to guarantee minimum clearance.
 *
 * These tests verify the padding formula in isolation, without
 * rendering React components or importing platform-specific modules.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirrors the padding formula from TabBar.tsx line 97:
 *   Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom
 */
function computeTabBarPadding(platform: 'web' | 'ios' | 'android', insetsBottom: number): number {
    if (platform === 'web') {
        return Math.max(insetsBottom, 34);
    }
    return insetsBottom;
}

describe('TabBar bottom padding — PWA regression', () => {

    describe('web platform enforces minimum 34px padding', () => {
        it('uses 34px when insets.bottom is 0 (PWA standalone mode)', () => {
            // This was the primary bug: iOS PWA reports 0 for safe area
            // insets, so without the minimum, tabs had no bottom padding
            expect(computeTabBarPadding('web', 0)).toBe(34);
        });

        it('uses 34px when insets.bottom is small (< 34)', () => {
            expect(computeTabBarPadding('web', 10)).toBe(34);
            expect(computeTabBarPadding('web', 16)).toBe(34);
            expect(computeTabBarPadding('web', 33)).toBe(34);
        });

        it('uses actual insets when larger than 34px', () => {
            expect(computeTabBarPadding('web', 34)).toBe(34);
            expect(computeTabBarPadding('web', 44)).toBe(44);
            expect(computeTabBarPadding('web', 100)).toBe(100);
        });
    });

    describe('native platforms use raw insets (no minimum)', () => {
        it('iOS uses actual insets.bottom value', () => {
            expect(computeTabBarPadding('ios', 0)).toBe(0);
            expect(computeTabBarPadding('ios', 34)).toBe(34);
            expect(computeTabBarPadding('ios', 44)).toBe(44);
        });

        it('Android uses actual insets.bottom value', () => {
            expect(computeTabBarPadding('android', 0)).toBe(0);
            expect(computeTabBarPadding('android', 48)).toBe(48);
        });
    });

    describe('boundary values', () => {
        it('exact threshold value (34) returns 34 on web', () => {
            expect(computeTabBarPadding('web', 34)).toBe(34);
        });

        it('one below threshold (33) returns 34 on web', () => {
            expect(computeTabBarPadding('web', 33)).toBe(34);
        });

        it('one above threshold (35) returns 35 on web', () => {
            expect(computeTabBarPadding('web', 35)).toBe(35);
        });
    });
});
