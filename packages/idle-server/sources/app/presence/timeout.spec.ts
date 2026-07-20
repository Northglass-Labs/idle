import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRESENCE_TIMEOUT_BATCH_SIZE,
    startTimeout,
    type PresenceTimeoutDependencies,
} from './timeout';

const delayMock = vi.fn();
const foreverMock = vi.fn();
const machineFindManyMock = vi.fn();
const sessionFindManyMock = vi.fn();

const dependencies: PresenceTimeoutDependencies = {
    db: {
        machine: {
            findMany: machineFindManyMock,
            updateManyAndReturn: vi.fn(),
        },
        session: {
            findMany: sessionFindManyMock,
            updateManyAndReturn: vi.fn(),
        },
    },
    delay: delayMock,
    forever: foreverMock,
    shutdownSignal: new AbortController().signal,
    buildMachineActivityEphemeral: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    eventRouter: { emitEphemeral: vi.fn() },
};

describe('presence timeout worker lifecycle', () => {
    beforeEach(() => {
        delayMock.mockReset();
        foreverMock.mockReset();
        machineFindManyMock.mockReset().mockResolvedValue([]);
        sessionFindManyMock.mockReset().mockResolvedValue([]);
    });

    it('returns one scheduled pass to the shutdown-aware forever loop', async () => {
        startTimeout(dependencies);
        expect(foreverMock).toHaveBeenCalledTimes(1);

        const pass = foreverMock.mock.calls[0][1] as () => Promise<void>;
        delayMock
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('timeout callback looped internally'));

        await expect(pass()).resolves.toBeUndefined();
        expect(sessionFindManyMock).toHaveBeenCalledTimes(1);
        expect(machineFindManyMock).toHaveBeenCalledTimes(1);
        expect(delayMock).toHaveBeenCalledTimes(1);
    });

    it('bounds stale-row materialization and selects only routing fields', async () => {
        startTimeout(dependencies);
        const pass = foreverMock.mock.calls[0][1] as () => Promise<void>;

        await pass();

        const boundedQuery = {
            where: {
                active: true,
                lastActiveAt: { lte: expect.any(Date) },
            },
            orderBy: { lastActiveAt: 'asc' },
            take: PRESENCE_TIMEOUT_BATCH_SIZE,
            select: { id: true, accountId: true, lastActiveAt: true },
        };
        expect(sessionFindManyMock).toHaveBeenCalledWith(boundedQuery);
        expect(machineFindManyMock).toHaveBeenCalledWith(boundedQuery);
    });
});
