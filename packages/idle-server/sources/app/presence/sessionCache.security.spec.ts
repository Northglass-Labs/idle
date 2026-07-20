import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, logMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        machine: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
    },
    logMock: vi.fn(),
}));

vi.mock('../../storage/db', () => ({ db: dbMock }));
vi.mock('../../utils/log', () => ({ log: logMock }));
vi.mock('../monitoring/metrics2', () => ({
    sessionCacheCounter: { inc: vi.fn() },
    databaseUpdatesSkippedCounter: { inc: vi.fn() },
}));

import { activityCache } from './sessionCache';

type CacheHarness = {
    sessionCache: Map<string, unknown>;
    machineCache: Map<string, unknown>;
    accountEntryCounts?: Map<string, number>;
    flushPendingUpdates(): Promise<void>;
};

const cache = activityCache as unknown as CacheHarness;

describe('activity cache resource bounds', () => {
    const perAccountLimit = 256;
    const globalLimit = 4_096;
    const flushBatchLimit = 128;
    let now = 1_000_000;
    let dateNowSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        activityCache.shutdown();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        cache.sessionCache.clear();
        cache.machineCache.clear();
        cache.accountEntryCounts?.clear();
        now = 1_000_000;
        dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        dbMock.session.findUnique.mockImplementation(async ({ where }: any) => ({
            id: where.id,
            accountId: where.accountId,
            lastActiveAt: new Date(0),
        }));
        dbMock.machine.findUnique.mockImplementation(async ({ where }: any) => ({
            id: where.accountId_id.id,
            accountId: where.accountId_id.accountId,
            lastActiveAt: new Date(0),
        }));
        dbMock.session.updateMany.mockResolvedValue({ count: 1 });
        dbMock.machine.update.mockResolvedValue({});
    });

    afterEach(() => {
        dateNowSpy.mockRestore();
    });

    afterAll(() => {
        cache.sessionCache.clear();
        cache.machineCache.clear();
        cache.accountEntryCounts?.clear();
    });

    it('caps the combined session and machine working set for one account', async () => {
        for (let index = 0; index < perAccountLimit / 2; index += 1) {
            await expect(activityCache.isSessionValid(`session-${index}`, 'account-1')).resolves.toBe(true);
            await expect(activityCache.isMachineValid(`machine-${index}`, 'account-1')).resolves.toBe(true);
        }

        const sessionLookups = dbMock.session.findUnique.mock.calls.length;
        const machineLookups = dbMock.machine.findUnique.mock.calls.length;
        await expect(activityCache.isMachineValid('machine-over-limit', 'account-1')).resolves.toBe(false);

        expect(cache.sessionCache.size + cache.machineCache.size).toBe(perAccountLimit);
        expect(dbMock.session.findUnique).toHaveBeenCalledTimes(sessionLookups);
        expect(dbMock.machine.findUnique).toHaveBeenCalledTimes(machineLookups);

        await expect(activityCache.isSessionValid('session-0', 'account-1')).resolves.toBe(true);
        expect(dbMock.session.findUnique).toHaveBeenCalledTimes(sessionLookups);
    });

    it('keeps total process cache cardinality bounded across many accounts', async () => {
        for (let index = 0; index < globalLimit + 64; index += 1) {
            const accountId = `account-${Math.floor(index / perAccountLimit)}`;
            await expect(activityCache.isMachineValid(`global-machine-${index}`, accountId)).resolves.toBe(true);
        }

        expect(cache.machineCache.size + cache.sessionCache.size).toBe(globalLimit);

        const cachedMachineIds = [...cache.machineCache.keys()];
        dbMock.machine.findUnique.mockResolvedValueOnce(null);
        await expect(activityCache.isMachineValid('invalid-machine', 'account-invalid')).resolves.toBe(false);

        expect([...cache.machineCache.keys()]).toEqual(cachedMachineIds);
    });

    it('limits each flush and database concurrency while draining later batches', async () => {
        for (let index = 0; index < flushBatchLimit + 22; index += 1) {
            const sessionId = `pending-session-${index}`;
            await activityCache.isSessionValid(sessionId, 'account-1');
            expect(activityCache.queueSessionUpdate(sessionId, now)).toBe(true);
        }

        let activeWrites = 0;
        let maxActiveWrites = 0;
        dbMock.session.updateMany.mockImplementation(async () => {
            activeWrites += 1;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeWrites -= 1;
            return { count: 1 };
        });

        await cache.flushPendingUpdates();

        expect(dbMock.session.updateMany).toHaveBeenCalledTimes(flushBatchLimit);
        expect(maxActiveWrites).toBeLessThanOrEqual(8);

        await cache.flushPendingUpdates();
        expect(dbMock.session.updateMany).toHaveBeenCalledTimes(flushBatchLimit + 22);
    });

    it('retries a failed heartbeat instead of dropping it from the bounded queue', async () => {
        await activityCache.isSessionValid('retry-session', 'account-1');
        expect(activityCache.queueSessionUpdate('retry-session', now)).toBe(true);
        dbMock.session.updateMany.mockRejectedValueOnce(new Error('database unavailable'));

        await cache.flushPendingUpdates();
        expect(dbMock.session.updateMany).toHaveBeenCalledTimes(1);

        dbMock.session.updateMany.mockResolvedValue({ count: 1 });
        await cache.flushPendingUpdates();
        await cache.flushPendingUpdates();

        expect(dbMock.session.updateMany).toHaveBeenCalledTimes(2);
    });

    it('preserves a newer heartbeat queued while an older one is being flushed', async () => {
        await activityCache.isSessionValid('live-session', 'account-1');
        expect(activityCache.queueSessionUpdate('live-session', now)).toBe(true);

        let finishFirstWrite: (() => void) | undefined;
        dbMock.session.updateMany.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                finishFirstWrite = resolve;
            });
            return { count: 1 };
        });

        const firstFlush = cache.flushPendingUpdates();
        await vi.waitFor(() => expect(finishFirstWrite).toBeTypeOf('function'));
        now += 1_000;
        expect(activityCache.queueSessionUpdate('live-session', now)).toBe(true);
        finishFirstWrite?.();
        await firstFlush;

        await cache.flushPendingUpdates();

        expect(dbMock.session.updateMany).toHaveBeenCalledTimes(2);
        expect(dbMock.session.updateMany.mock.calls[1][0].data.lastActiveAt).toEqual(new Date(now));
    });

    it('retains the existing 30-second TTL cleanup behavior', async () => {
        await expect(activityCache.isMachineValid('ttl-machine', 'account-1')).resolves.toBe(true);
        expect(cache.machineCache.has('ttl-machine')).toBe(true);

        now += 30_001;
        activityCache.cleanup();

        expect(cache.machineCache.has('ttl-machine')).toBe(false);
    });
});
