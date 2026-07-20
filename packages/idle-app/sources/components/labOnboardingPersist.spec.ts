import { describe, expect, it } from 'vitest';
import {
    shouldShowLabOnboarding,
    shouldShowSwipeRemovedHint,
    shouldShowSessionActionsHint,
} from './labOnboardingPersist';

describe('shouldShowLabOnboarding', () => {
    it('returns true when never seen', () => {
        expect(shouldShowLabOnboarding(undefined)).toBe(true);
    });
    it('returns false once seen', () => {
        expect(shouldShowLabOnboarding('seen')).toBe(false);
    });
    it('returns true for any non-seen value (defensive)', () => {
        expect(shouldShowLabOnboarding('')).toBe(true);
        expect(shouldShowLabOnboarding('something-else')).toBe(true);
    });
});

describe('shouldShowSwipeRemovedHint', () => {
    it('returns true when never seen', () => {
        expect(shouldShowSwipeRemovedHint(undefined)).toBe(true);
    });
    it('returns false once seen', () => {
        expect(shouldShowSwipeRemovedHint('seen')).toBe(false);
    });
});

describe('shouldShowSessionActionsHint', () => {
    it('returns false when seen flag is set regardless of other conditions', () => {
        expect(shouldShowSessionActionsHint('seen', false, 5)).toBe(false);
        expect(shouldShowSessionActionsHint('seen', true, 5)).toBe(false);
        expect(shouldShowSessionActionsHint('seen', true, 100)).toBe(false);
    });

    it('returns false when not paired yet, regardless of session count', () => {
        expect(shouldShowSessionActionsHint(undefined, false, 5)).toBe(false);
        expect(shouldShowSessionActionsHint(undefined, false, 0)).toBe(false);
    });

    it('returns false when paired but fewer than 2 sessions', () => {
        expect(shouldShowSessionActionsHint(undefined, true, 0)).toBe(false);
        expect(shouldShowSessionActionsHint(undefined, true, 1)).toBe(false);
    });

    it('returns true when paired, 2+ sessions, never seen', () => {
        expect(shouldShowSessionActionsHint(undefined, true, 2)).toBe(true);
        expect(shouldShowSessionActionsHint(undefined, true, 10)).toBe(true);
        expect(shouldShowSessionActionsHint(undefined, true, 1000)).toBe(true);
    });
});
