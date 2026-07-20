import { describe, expect, it } from 'vitest';

import {
    isRateLimitedSocketMutationEvent,
    SocketMutationRateLimiter,
} from './socketMutationRateLimit';

describe('authenticated socket mutation rate limit', () => {
    it('enforces one rolling budget per account across time and sockets', () => {
        const limiter = new SocketMutationRateLimiter(3);

        expect(limiter.allow('account-a', 1_000)).toBe(true);
        expect(limiter.allow('account-a', 1_000)).toBe(true);
        expect(limiter.allow('account-a', 1_000)).toBe(true);
        expect(limiter.allow('account-a', 1_000)).toBe(false);
        expect(limiter.allow('account-b', 1_000)).toBe(true);
        expect(limiter.allow('account-a', 20_999)).toBe(false);
        expect(limiter.allow('account-a', 21_000)).toBe(true);
    });

    it('caps account buckets, prunes stale entries, and does not mint budget on clock rollback', () => {
        const limiter = new SocketMutationRateLimiter(1, 2, 60_000);

        expect(limiter.allow('account-a', 10_000)).toBe(true);
        expect(limiter.allow('account-a', 5_000)).toBe(false);
        expect(limiter.allow('account-b', 10_000)).toBe(true);
        expect(limiter.allow('account-c', 10_000)).toBe(false);
        expect(limiter.allow('account-c', 70_001)).toBe(true);
    });

    it.each([
        'machine-alive',
        'machine-update-metadata',
        'machine-update-state',
        'message',
        'session-alive',
        'session-end',
        'update-metadata',
        'update-state',
    ])('classifies %s as an account-budgeted mutation', (event) => {
        expect(isRateLimitedSocketMutationEvent(event)).toBe(true);
    });

    it.each([
        'app-state',
        'ping',
        'rpc-call',
        'rpc-register',
        'rpc-unregister',
        'usage-report',
        'unknown',
    ])('does not double-limit or mutation-limit %s', (event) => {
        expect(isRateLimitedSocketMutationEvent(event)).toBe(false);
    });
});
