import { describe, expect, it } from 'vitest';

import { ConnectionBurstLimiter } from './connectionBurstLimit';

describe('ConnectionBurstLimiter', () => {
    it('keeps same-source rejection work and retained state constant', () => {
        let now = 1_000;
        const limiter = new ConnectionBurstLimiter({
            perSourceCapacity: 30,
            perSourceWindowMs: 60_000,
            globalCapacity: 10_000_000,
            globalWindowMs: 60_000,
            clock: () => now,
        });

        for (let index = 0; index < 30; index++) {
            expect(limiter.allow('198.51.100.10')).toBe(true);
        }
        for (let index = 0; index < 100_000; index++) {
            expect(limiter.allow('198.51.100.10')).toBe(false);
        }

        expect(limiter.stats()).toEqual({ sources: 1, admitted: 30, rejected: 100_000 });
        expect(limiter.inspectSource('198.51.100.10')).toMatchObject({ tokens: 0 });

        now += 2_001;
        expect(limiter.allow('198.51.100.10')).toBe(true);
    });

    it('does not let rotating source addresses exceed the process budget or grow rejected state', () => {
        const limiter = new ConnectionBurstLimiter({
            perSourceCapacity: 30,
            perSourceWindowMs: 60_000,
            globalCapacity: 3,
            globalWindowMs: 60_000,
            maxSources: 100,
            clock: () => 1_000,
        });

        expect(limiter.allow('198.51.100.1')).toBe(true);
        expect(limiter.allow('198.51.100.2')).toBe(true);
        expect(limiter.allow('198.51.100.3')).toBe(true);
        for (let index = 4; index < 10_000; index++) {
            expect(limiter.allow(`198.51.100.${index}`)).toBe(false);
        }

        expect(limiter.stats()).toEqual({ sources: 3, admitted: 3, rejected: 9_996 });
    });

    it('refuses new source state when its bounded store is full', () => {
        const limiter = new ConnectionBurstLimiter({
            maxSources: 2,
            globalCapacity: 100,
            clock: () => 1_000,
        });

        expect(limiter.allow('198.51.100.1')).toBe(true);
        expect(limiter.allow('198.51.100.2')).toBe(true);
        expect(limiter.allow('198.51.100.3')).toBe(false);
        expect(limiter.stats().sources).toBe(2);
    });

    it('prunes inactive source state without letting clock rollback mint tokens', () => {
        let now = 60_000;
        const limiter = new ConnectionBurstLimiter({
            perSourceCapacity: 1,
            perSourceWindowMs: 60_000,
            sourceRetentionMs: 60_000,
            globalCapacity: 100,
            clock: () => now,
        });

        expect(limiter.allow('198.51.100.1')).toBe(true);
        now = 1_000;
        expect(limiter.allow('198.51.100.1')).toBe(false);
        now = 120_001;
        expect(limiter.prune()).toBe(1);
        expect(limiter.stats().sources).toBe(0);
    });

    it('samples rejection logs independently from attacker-controlled source keys', () => {
        let now = 1_000;
        const limiter = new ConnectionBurstLimiter({
            rejectionLogIntervalMs: 5_000,
            clock: () => now,
        });

        expect(limiter.shouldLogRejection()).toBe(true);
        expect(limiter.shouldLogRejection()).toBe(false);
        now += 5_001;
        expect(limiter.shouldLogRejection()).toBe(true);
    });
});
