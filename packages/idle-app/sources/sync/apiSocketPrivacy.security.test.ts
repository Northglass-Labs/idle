import { describe, expect, it } from 'vitest';

import { getSafeConnectionErrorMessage } from './socketDiagnosticPrivacy';

describe('Socket diagnostic privacy', () => {
    it('does not expose relay-controlled error text in the status sheet or clipboard', () => {
        const sensitiveMarker = 'PRIVATE_RELAY_PATH_AND_ACCOUNT_MARKER';
        const message = getSafeConnectionErrorMessage(new Error(sensitiveMarker));

        expect(message).toBe('Connection failed. Check the relay URL, network, and account pairing.');
        expect(message).not.toContain(sensitiveMarker);
    });

    it('returns the same bounded message for arbitrary socket error shapes', () => {
        const expected = 'Connection failed. Check the relay URL, network, and account pairing.';

        expect(getSafeConnectionErrorMessage('attacker-controlled')).toBe(expected);
        expect(getSafeConnectionErrorMessage({ message: 'attacker-controlled', stack: 'private' })).toBe(expected);
        expect(getSafeConnectionErrorMessage(null)).toBe(expected);
    });
});
