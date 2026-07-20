import { describe, expect, it } from 'vitest';

import { InFlightAttachmentTransferLimiter } from './attachmentTransferLimit';

describe('InFlightAttachmentTransferLimiter', () => {
    it('bounds active bytes and transfers per account', () => {
        const limiter = new InFlightAttachmentTransferLimiter({
            maxBytesPerAccount: 20,
            maxTransfersPerAccount: 2,
            maxBytesTotal: 100,
            maxTransfersTotal: 10,
        });
        const first = limiter.tryAcquire('account-1', 10);
        const second = limiter.tryAcquire('account-1', 10);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(limiter.tryAcquire('account-1', 1)).toBeNull();
        expect(limiter.stats()).toEqual({ bytes: 20, transfers: 2, accounts: 1 });

        first?.();
        expect(limiter.tryAcquire('account-1', 1)).not.toBeNull();
    });

    it('bounds rotating accounts globally and releases leases idempotently', () => {
        const limiter = new InFlightAttachmentTransferLimiter({
            maxBytesPerAccount: 100,
            maxTransfersPerAccount: 10,
            maxBytesTotal: 10,
            maxTransfersTotal: 2,
        });
        const first = limiter.tryAcquire('account-1', 5)!;
        const second = limiter.tryAcquire('account-2', 5)!;

        expect(limiter.tryAcquire('account-3', 1)).toBeNull();
        first();
        first();
        second();
        expect(limiter.stats()).toEqual({ bytes: 0, transfers: 0, accounts: 0 });
    });
});
