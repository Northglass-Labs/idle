import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ useSegments: () => [] }));
vi.mock('./tracking', () => ({ tracking: null }));

import { getScreenCategory } from './useTrackScreens';

describe('getScreenCategory', () => {
    it('keeps only the first non-group route segment', () => {
        expect(getScreenCategory(['(app)', 'session', 'sensitive-session-id'])).toBe('session');
        expect(getScreenCategory(['(app)', 'settings', 'voice'])).toBe('settings');
    });

    it('rejects malformed or oversized segments', () => {
        expect(getScreenCategory(['(app)', 'https://example.test/private'])).toBe('unknown');
        expect(getScreenCategory(['(app)', 'x'.repeat(65)])).toBe('unknown');
        expect(getScreenCategory(['(app)'])).toBe('root');
    });
});
