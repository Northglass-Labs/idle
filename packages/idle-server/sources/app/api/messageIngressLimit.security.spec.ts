import { describe, expect, it } from 'vitest';

import { InFlightMessageByteLimiter } from './messageIngressLimit';

describe('InFlightMessageByteLimiter', () => {
    it('bounds concurrent bytes and slots for one authenticated account', () => {
        const limiter = new InFlightMessageByteLimiter({
            maxBytesPerAccount: 12,
            maxRequestsPerAccount: 2,
            maxBytesTotal: 100,
            maxRequestsTotal: 10,
        });
        const first = limiter.tryAcquire('account-1', 6);
        const second = limiter.tryAcquire('account-1', 6);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(limiter.tryAcquire('account-1', 1)).toBeNull();
        expect(limiter.stats()).toEqual({ bytes: 12, requests: 2, accounts: 1 });

        first?.();
        expect(limiter.tryAcquire('account-1', 1)).not.toBeNull();
    });

    it('bounds aggregate bytes across rotating accounts and releases idempotently', () => {
        const limiter = new InFlightMessageByteLimiter({
            maxBytesPerAccount: 100,
            maxRequestsPerAccount: 10,
            maxBytesTotal: 10,
            maxRequestsTotal: 2,
        });
        const first = limiter.tryAcquire('account-1', 5)!;
        const second = limiter.tryAcquire('account-2', 5)!;

        expect(limiter.tryAcquire('account-3', 1)).toBeNull();
        first();
        first();
        second();
        expect(limiter.stats()).toEqual({ bytes: 0, requests: 0, accounts: 0 });
    });
});
