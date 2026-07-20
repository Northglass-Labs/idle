import { describe, it, expect } from 'vitest';
import { getSessionLastSeenTimestamp } from './sessionLastSeen';

describe('getSessionLastSeenTimestamp', () => {
    it('prefers activeAt over updatedAt — activeAt tracks real session activity, updatedAt bumps on any metadata sync', () => {
        // Metadata synchronization must not make an inactive session appear recent.
        expect(getSessionLastSeenTimestamp({ activeAt: 1000, updatedAt: 50000 })).toBe(1000);
    });

    it('falls back to updatedAt when activeAt is 0 (fresh session pre-first-activity)', () => {
        expect(getSessionLastSeenTimestamp({ activeAt: 0, updatedAt: 50000 })).toBe(50000);
    });

    it('returns 0 when both timestamps are missing — consumers gate display on > 0', () => {
        expect(getSessionLastSeenTimestamp({ activeAt: 0, updatedAt: 0 })).toBe(0);
    });

    it('returns activeAt even when both timestamps are nonzero', () => {
        expect(getSessionLastSeenTimestamp({ activeAt: 100, updatedAt: 999_999_999 })).toBe(100);
    });
});
