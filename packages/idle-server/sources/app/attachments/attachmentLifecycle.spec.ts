import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock, inTxMock, resetState } = vi.hoisted(() => {
    type Status = 'PENDING' | 'WRITING' | 'UPLOADED';
    type Transport = 'DIRECT' | 'RELAY';
    type Row = {
        id: string;
        accountId: string;
        sessionId: string;
        ref: string;
        size: number;
        status: Status;
        transport: Transport;
        expiresAt: Date;
        uploadedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
    };

    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        attachments: [] as Row[],
        budgetBytes: 0n,
        budgetObjects: 0n,
    };

    const matches = (row: Row, where: any): boolean => {
        if (!where) return true;
        if (where.id !== undefined) {
            if (typeof where.id === 'string' && row.id !== where.id) return false;
            if (where.id.in && !where.id.in.includes(row.id)) return false;
        }
        if (where.accountId !== undefined && row.accountId !== where.accountId) return false;
        if (where.sessionId !== undefined && row.sessionId !== where.sessionId) return false;
        if (where.ref !== undefined && row.ref !== where.ref) return false;
        if (where.status !== undefined) {
            if (typeof where.status === 'string' && row.status !== where.status) return false;
            if (where.status.in && !where.status.in.includes(row.status)) return false;
        }
        if (where.transport !== undefined && row.transport !== where.transport) return false;
        if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
        if (where.expiresAt?.lte && !(row.expiresAt <= where.expiresAt.lte)) return false;
        if (where.OR && !where.OR.some((clause: any) => matches(row, clause))) return false;
        return true;
    };

    const attachment = {
        count: vi.fn(async ({ where }: any) => state.attachments.filter((row) => matches(row, where)).length),
        aggregate: vi.fn(async ({ where }: any) => ({
            _sum: {
                size: state.attachments
                    .filter((row) => matches(row, where))
                    .reduce((sum, row) => sum + row.size, 0),
            },
        })),
        create: vi.fn(async ({ data }: any) => {
            const now = new Date();
            const row: Row = {
                uploadedAt: null,
                createdAt: now,
                updatedAt: now,
                ...data,
            };
            state.attachments.push(row);
            return row;
        }),
        findFirst: vi.fn(async ({ where }: any) => state.attachments.find((row) => matches(row, where)) ?? null),
        findMany: vi.fn(async ({ where, take }: any) => state.attachments.filter((row) => matches(row, where)).slice(0, take)),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const rows = state.attachments.filter((row) => matches(row, where));
            for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
            return { count: rows.length };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const before = state.attachments.length;
            state.attachments = state.attachments.filter((row) => !matches(row, where));
            return { count: before - state.attachments.length };
        }),
    };

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) => state.sessions.find(
                (session) => session.id === where.id && session.accountId === where.accountId,
            ) ?? null),
        },
        attachment,
        attachmentStorageBudget: {
            updateMany: vi.fn(async ({ where, data }: any) => {
                const byteCondition = where.accountedBytes ?? {};
                const objectCondition = where.objectCount ?? {};
                if (byteCondition.lte !== undefined && state.budgetBytes > byteCondition.lte) {
                    return { count: 0 };
                }
                if (byteCondition.gte !== undefined && state.budgetBytes < byteCondition.gte) {
                    return { count: 0 };
                }
                if (objectCondition.lt !== undefined && state.budgetObjects >= objectCondition.lt) {
                    return { count: 0 };
                }
                if (objectCondition.gte !== undefined && state.budgetObjects < objectCondition.gte) {
                    return { count: 0 };
                }
                if (data.accountedBytes?.increment !== undefined) {
                    state.budgetBytes += data.accountedBytes.increment;
                }
                if (data.accountedBytes?.decrement !== undefined) {
                    state.budgetBytes -= data.accountedBytes.decrement;
                }
                if (data.objectCount?.increment !== undefined) {
                    state.budgetObjects += data.objectCount.increment;
                }
                if (data.objectCount?.decrement !== undefined) {
                    state.budgetObjects -= data.objectCount.decrement;
                }
                return { count: 1 };
            }),
        },
    };

    let txTail: Promise<unknown> = Promise.resolve();
    const inTxMock = vi.fn((fn: (tx: typeof dbMock) => Promise<unknown>) => {
        const result = txTail.then(() => fn(dbMock));
        txTail = result.then(() => undefined, () => undefined);
        return result;
    });

    const resetState = () => {
        state.sessions = [{ id: 'session-1', accountId: 'account-1' }];
        state.attachments = [];
        state.budgetBytes = 0n;
        state.budgetObjects = 0n;
        delete process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES;
        delete process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS;
        txTail = Promise.resolve();
        vi.clearAllMocks();
    };

    return { state, dbMock, inTxMock, resetState };
});

vi.mock('../../storage/db', () => ({ db: dbMock }));
vi.mock('../../storage/inTx', () => ({ inTx: inTxMock }));

import {
    ACCOUNT_ATTACHMENT_COUNT_LIMIT,
    AttachmentLifecycleError,
    MAX_ATTACHMENT_SIZE,
    SESSION_ATTACHMENT_BYTE_LIMIT,
    SESSION_ATTACHMENT_COUNT_LIMIT,
    adoptLegacyAttachment,
    assertAttachmentSessionOwner,
    cancelPendingAttachment,
    claimLocalAttachmentBeforeBody,
    completeLocalAttachment,
    confirmS3Attachment,
    deleteExpiredAttachmentReservations,
    getOwnedAttachment,
    releaseLocalAttachment,
    reserveAttachment,
} from './attachmentLifecycle';

function seedAttachment(overrides: Partial<(typeof state.attachments)[number]> = {}) {
    const now = new Date();
    state.attachments.push({
        id: `attachment-${state.attachments.length}`,
        accountId: 'account-1',
        sessionId: 'session-1',
        ref: `sessions/session-1/attachments/${crypto.randomUUID()}.enc`,
        size: 1,
        status: 'UPLOADED',
        transport: 'DIRECT',
        expiresAt: new Date(now.getTime() - 1),
        uploadedAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });
}

describe('attachment lifecycle quotas and reservations', () => {
    beforeEach(resetState);

    it('creates a durable reservation inside the serializable transaction boundary', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 1024, 'DIRECT');

        expect(inTxMock).toHaveBeenCalledTimes(1);
        expect(reservation.ref).toMatch(/^sessions\/session-1\/attachments\/[0-9a-f-]+\.enc$/);
        expect(reservation.size).toBe(1024);
        expect(reservation.status).toBe('PENDING');
        expect(reservation.transport).toBe('DIRECT');
        expect(state.attachments).toHaveLength(1);
        expect(state.budgetBytes).toBe(1024n);
        expect(state.budgetObjects).toBe(1n);
    });

    it('enforces one deployment byte budget across unrelated account identities', async () => {
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES = '100';
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS = '10';
        state.sessions.push({ id: 'session-2', accountId: 'account-2' });

        await reserveAttachment('account-1', 'session-1', 60);
        await reserveAttachment('account-2', 'session-2', 40);
        await expect(reserveAttachment('account-2', 'session-2', 1))
            .rejects.toMatchObject({ code: 'QUOTA' });

        expect(state.budgetBytes).toBe(100n);
        expect(state.attachments).toHaveLength(2);
    });

    it('serializes cross-account claims so concurrent reservations cannot exceed the deployment cap', async () => {
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES = '100';
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS = '10';
        state.sessions.push({ id: 'session-2', accountId: 'account-2' });

        const results = await Promise.allSettled([
            reserveAttachment('account-1', 'session-1', 60),
            reserveAttachment('account-2', 'session-2', 60),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(state.budgetBytes).toBe(60n);
        expect(state.budgetObjects).toBe(1n);
    });

    it('enforces the deployment object ceiling independently of byte headroom', async () => {
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES = '1000';
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS = '2';
        state.sessions.push({ id: 'session-2', accountId: 'account-2' });

        await reserveAttachment('account-1', 'session-1', 1);
        await reserveAttachment('account-2', 'session-2', 1);
        await expect(reserveAttachment('account-2', 'session-2', 1))
            .rejects.toMatchObject({ code: 'QUOTA' });

        expect(state.budgetBytes).toBe(2n);
        expect(state.budgetObjects).toBe(2n);
    });

    it('fails closed for malformed deployment storage limits', async () => {
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES = 'unbounded';

        await expect(reserveAttachment('account-1', 'session-1', 1))
            .rejects.toMatchObject({ code: 'QUOTA' });
        expect(state.attachments).toHaveLength(0);
        expect(state.budgetBytes).toBe(0n);
    });

    it('rejects non-positive, fractional, and oversized declarations', async () => {
        for (const size of [0, -1, 1.5, MAX_ATTACHMENT_SIZE + 1]) {
            await expect(reserveAttachment('account-1', 'session-1', size)).rejects.toMatchObject({ code: 'INVALID' });
        }
        expect(state.attachments).toHaveLength(0);
    });

    it('counts live reservations and retained uploads against per-session count quota', async () => {
        for (let index = 0; index < SESSION_ATTACHMENT_COUNT_LIMIT; index++) {
            seedAttachment({
                id: `a-${index}`,
                status: index % 2 === 0 ? 'UPLOADED' : 'PENDING',
                expiresAt: new Date(Date.now() + 60_000),
            });
        }

        await expect(reserveAttachment('account-1', 'session-1', 1)).rejects.toMatchObject({ code: 'QUOTA' });
        expect(state.attachments).toHaveLength(SESSION_ATTACHMENT_COUNT_LIMIT);
    });

    it('counts reserved bytes and retained bytes against per-session byte quota', async () => {
        seedAttachment({ size: SESSION_ATTACHMENT_BYTE_LIMIT, status: 'UPLOADED' });

        await expect(reserveAttachment('account-1', 'session-1', 1)).rejects.toMatchObject({ code: 'QUOTA' });
    });

    it('enforces the per-account byte quota across many sessions before the count cap', async () => {
        for (let index = 0; index < 1_024; index++) {
            seedAttachment({
                id: `bytes-${index}`,
                sessionId: `other-session-${index % 8}`,
                size: MAX_ATTACHMENT_SIZE,
            });
        }

        await expect(reserveAttachment('account-1', 'session-1', 1)).rejects.toMatchObject({ code: 'QUOTA' });
    });

    it('enforces the per-account count quota across sessions', async () => {
        state.sessions.push({ id: 'session-2', accountId: 'account-1' });
        for (let index = 0; index < ACCOUNT_ATTACHMENT_COUNT_LIMIT; index++) {
            seedAttachment({
                id: `a-${index}`,
                sessionId: index % 2 === 0 ? 'session-1' : 'session-2',
            });
        }

        await expect(reserveAttachment('account-1', 'session-1', 1)).rejects.toMatchObject({ code: 'QUOTA' });
    });

    it('keeps expired direct capabilities quota-charged until their owner is removed', async () => {
        for (let index = 0; index < SESSION_ATTACHMENT_COUNT_LIMIT; index++) {
            seedAttachment({
                id: `expired-${index}`,
                status: 'PENDING',
                transport: 'DIRECT',
                expiresAt: new Date(Date.now() - 1),
            });
        }

        await expect(reserveAttachment('account-1', 'session-1', 1, 'DIRECT'))
            .rejects.toMatchObject({ code: 'QUOTA' });
    });

    it('serializes concurrent reservations so one remaining slot cannot be oversubscribed', async () => {
        for (let index = 0; index < SESSION_ATTACHMENT_COUNT_LIMIT - 1; index++) {
            seedAttachment({ id: `existing-${index}` });
        }

        const results = await Promise.allSettled([
            reserveAttachment('account-1', 'session-1', 1),
            reserveAttachment('account-1', 'session-1', 1),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(state.attachments).toHaveLength(SESSION_ATTACHMENT_COUNT_LIMIT);
    });

    it('atomically consumes a local upload capability before request-body parsing', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 20, 'RELAY');

        const claimed = await claimLocalAttachmentBeforeBody(
            'account-1',
            'session-1',
            reservation.ref,
        );

        expect(claimed).toMatchObject({ id: reservation.id, size: 20, status: 'WRITING' });
        await expect(claimLocalAttachmentBeforeBody('account-1', 'session-1', reservation.ref))
            .rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('cancels an unissued pending reservation when storage cannot create the capability', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 20);

        await cancelPendingAttachment('account-1', reservation.id);

        expect(state.attachments).toHaveLength(0);
        expect(state.budgetBytes).toBe(0n);
        expect(state.budgetObjects).toBe(0n);
        await cancelPendingAttachment('account-1', reservation.id);
        expect(state.budgetBytes).toBe(0n);
    });

    it('releases a failed local write and an expired reservation exactly once', async () => {
        const local = await reserveAttachment('account-1', 'session-1', 20, 'RELAY');
        await claimLocalAttachmentBeforeBody('account-1', 'session-1', local.ref);
        await releaseLocalAttachment('account-1', local.id);
        await releaseLocalAttachment('account-1', local.id);

        const expired = await reserveAttachment('account-1', 'session-1', 30, 'RELAY');
        state.attachments.find((row) => row.id === expired.id)!.expiresAt = new Date(0);
        await deleteExpiredAttachmentReservations('account-1', [expired.id]);
        await deleteExpiredAttachmentReservations('account-1', [expired.id]);

        expect(state.attachments).toHaveLength(0);
        expect(state.budgetBytes).toBe(0n);
        expect(state.budgetObjects).toBe(0n);
    });

    it('never reaps an expired direct capability or releases its durable budget', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 30, 'DIRECT');
        state.attachments.find((row) => row.id === reservation.id)!.expiresAt = new Date(0);

        await deleteExpiredAttachmentReservations('account-1', [reservation.id]);

        expect(state.attachments).toHaveLength(1);
        expect(state.budgetBytes).toBe(30n);
        expect(state.budgetObjects).toBe(1n);
    });

    it('confirms an S3 upload only when the exact object size matches the reservation', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 20, 'DIRECT');

        await expect(confirmS3Attachment('account-1', 'session-1', reservation.ref, 21))
            .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
        const confirmed = await confirmS3Attachment('account-1', 'session-1', reservation.ref, 20);

        expect(confirmed.status).toBe('UPLOADED');
    });

    it('does not cross-consume direct and relay upload capabilities', async () => {
        const direct = await reserveAttachment('account-1', 'session-1', 20, 'DIRECT');
        const relay = await reserveAttachment('account-1', 'session-1', 20, 'RELAY');

        await expect(claimLocalAttachmentBeforeBody('account-1', 'session-1', direct.ref))
            .rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(confirmS3Attachment('account-1', 'session-1', relay.ref, 20))
            .rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('confirms an exact late direct upload without dropping its ownership row', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 20, 'DIRECT');
        state.attachments.find((row) => row.id === reservation.id)!.expiresAt = new Date(0);

        const confirmed = await confirmS3Attachment('account-1', 'session-1', reservation.ref, 20);

        expect(confirmed.status).toBe('UPLOADED');
        expect(state.attachments).toHaveLength(1);
        expect(state.budgetBytes).toBe(20n);
    });

    it('never authorizes another account or another session to reuse a ref', async () => {
        const reservation = await reserveAttachment('account-1', 'session-1', 20, 'RELAY');
        await claimLocalAttachmentBeforeBody('account-1', 'session-1', reservation.ref);
        await completeLocalAttachment('account-1', reservation.id);

        await expect(getOwnedAttachment('account-2', 'session-1', reservation.ref))
            .rejects.toBeInstanceOf(AttachmentLifecycleError);
        await expect(getOwnedAttachment('account-1', 'session-2', reservation.ref))
            .rejects.toBeInstanceOf(AttachmentLifecycleError);
    });

    it('rejects an untracked legacy lookup before storage access when the session is not owned', async () => {
        await expect(assertAttachmentSessionOwner('account-2', 'session-1'))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('adopts an existing encrypted legacy object into quota accounting without replacing it', async () => {
        const ref = `sessions/session-1/attachments/${crypto.randomUUID()}.enc`;
        const adopted = await adoptLegacyAttachment('account-1', 'session-1', ref, 2048);

        expect(adopted.ref).toBe(ref);
        expect(adopted.size).toBe(2048);
        expect(adopted.status).toBe('UPLOADED');
        expect(state.attachments).toHaveLength(1);
        expect(state.budgetBytes).toBe(2048n);
        expect(state.budgetObjects).toBe(1n);
    });
});
