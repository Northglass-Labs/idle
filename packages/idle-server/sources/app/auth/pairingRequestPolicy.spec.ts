import { describe, expect, it } from 'vitest';

import {
    isPairingRequestFresh,
    pairingRequestCutoff,
    PAIRING_REQUEST_TTL_MS,
} from './pairingRequestPolicy';

describe('pairing request lifetime policy', () => {
    it('uses one inclusive five-minute boundary for cleanup and approval', () => {
        const now = Date.UTC(2026, 6, 13, 12, 0, 0);
        const cutoff = pairingRequestCutoff(now);

        expect(cutoff.getTime()).toBe(now - PAIRING_REQUEST_TTL_MS);
        expect(isPairingRequestFresh(cutoff, now)).toBe(true);
        expect(isPairingRequestFresh(new Date(cutoff.getTime() - 1), now)).toBe(false);
    });

    it('fails closed for an invalid timestamp', () => {
        expect(isPairingRequestFresh(new Date(Number.NaN))).toBe(false);
    });
});
