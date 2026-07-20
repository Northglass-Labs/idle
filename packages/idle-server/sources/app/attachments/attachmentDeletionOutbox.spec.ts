import { beforeEach, describe, expect, it, vi } from 'vitest';

type DeletionRow = {
    id: string;
    ref: string;
    size: number | null;
    attempts: number;
    createdAt: Date;
    lastAttemptAt: Date | null;
};

const { state, dbMock, deleteAttachmentObjectsMock, onShutdownMock } = vi.hoisted(() => {
    const state = {
        rows: [] as DeletionRow[],
        budgetBytes: 20n,
        budgetObjects: 1n,
    };
    const dbMock = {
        attachmentDeletion: {
            findMany: vi.fn(async ({ take, where }: { take?: number; where?: { id: { in: string[] } } }) => {
                const rows = where
                    ? state.rows.filter((row) => where.id.in.includes(row.id))
                    : state.rows;
                return rows.slice(0, take ?? rows.length);
            }),
            deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
                const ids = new Set(where.id.in);
                const before = state.rows.length;
                state.rows = state.rows.filter((row) => !ids.has(row.id));
                return { count: before - state.rows.length };
            }),
            updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
                const ids = new Set(where.id.in);
                let count = 0;
                for (const row of state.rows) {
                    if (!ids.has(row.id)) continue;
                    row.attempts += 1;
                    row.lastAttemptAt = new Date();
                    count += 1;
                }
                return { count };
            }),
        },
        attachmentStorageBudget: {
            updateMany: vi.fn(async ({ data }: any) => {
                state.budgetBytes -= data.accountedBytes.decrement;
                state.budgetObjects -= data.objectCount.decrement;
                return { count: 1 };
            }),
        },
    };
    return {
        state,
        dbMock,
        deleteAttachmentObjectsMock: vi.fn(),
        onShutdownMock: vi.fn(),
    };
});

vi.mock('../../storage/db', () => ({ db: dbMock }));
vi.mock('../../storage/inTx', () => ({
    inTx: vi.fn(async (callback: (tx: typeof dbMock) => Promise<unknown>) => callback(dbMock)),
}));
vi.mock('../../storage/files', () => ({ deleteAttachmentObjects: deleteAttachmentObjectsMock }));
vi.mock('../../utils/log', () => ({ log: vi.fn() }));
vi.mock('../../utils/shutdown', () => ({ onShutdown: onShutdownMock }));

describe('attachment deletion outbox', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        state.rows = [{
            id: 'deletion-1',
            ref: 'sessions/s1/attachments/00000000-0000-4000-8000-000000000001.enc',
            size: 20,
            attempts: 0,
            createdAt: new Date(0),
            lastAttemptAt: null,
        }];
        state.budgetBytes = 20n;
        state.budgetObjects = 1n;
    });

    it('retains a failed deletion and retries it after a module restart', async () => {
        deleteAttachmentObjectsMock.mockRejectedValueOnce(new Error('storage unavailable'));

        const firstWorker = await import('./attachmentDeletionOutbox');
        await firstWorker.drainAttachmentDeletionOutbox();

        expect(state.rows).toHaveLength(1);
        expect(state.rows[0]?.attempts).toBe(1);
        expect(deleteAttachmentObjectsMock).toHaveBeenCalledWith([state.rows[0]?.ref]);

        vi.resetModules();
        deleteAttachmentObjectsMock.mockResolvedValueOnce(undefined);
        const restartedWorker = await import('./attachmentDeletionOutbox');
        await restartedWorker.drainAttachmentDeletionOutbox();

        expect(state.rows).toEqual([]);
        expect(state.budgetBytes).toBe(0n);
        expect(state.budgetObjects).toBe(0n);
        expect(deleteAttachmentObjectsMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the durable row when database acknowledgement fails after object deletion', async () => {
        deleteAttachmentObjectsMock.mockResolvedValueOnce(undefined);
        dbMock.attachmentDeletion.deleteMany.mockRejectedValueOnce(new Error('database unavailable'));

        const worker = await import('./attachmentDeletionOutbox');
        await expect(worker.drainAttachmentDeletionOutbox()).rejects.toThrow('database unavailable');

        expect(state.rows).toHaveLength(1);
        expect(state.budgetBytes).toBe(20n);
        expect(state.budgetObjects).toBe(1n);
    });

    it('acknowledges a pre-budget deletion job without decrementing the backfilled ledger', async () => {
        state.rows[0]!.size = null;
        deleteAttachmentObjectsMock.mockResolvedValueOnce(undefined);

        const worker = await import('./attachmentDeletionOutbox');
        await worker.drainAttachmentDeletionOutbox();

        expect(state.rows).toEqual([]);
        expect(state.budgetBytes).toBe(20n);
        expect(state.budgetObjects).toBe(1n);
        expect(dbMock.attachmentStorageBudget.updateMany).not.toHaveBeenCalled();
    });

    it('waits for an active drain before its shutdown phase completes', async () => {
        let releaseDeletion!: () => void;
        const deletionGate = new Promise<void>((resolve) => {
            releaseDeletion = resolve;
        });
        deleteAttachmentObjectsMock.mockReturnValueOnce(deletionGate);

        const worker = await import('./attachmentDeletionOutbox');
        worker.startAttachmentDeletionWorker();
        await vi.waitFor(() => {
            expect(deleteAttachmentObjectsMock).toHaveBeenCalledTimes(1);
            expect(onShutdownMock).toHaveBeenCalledTimes(1);
        });

        const shutdownHandler = onShutdownMock.mock.calls[0][1] as () => Promise<void>;
        let shutdownFinished = false;
        const shutdown = shutdownHandler().then(() => {
            shutdownFinished = true;
        });
        await Promise.resolve();
        expect(shutdownFinished).toBe(false);

        releaseDeletion();
        await shutdown;
        expect(state.rows).toEqual([]);
        expect(state.budgetBytes).toBe(0n);
    });
});
