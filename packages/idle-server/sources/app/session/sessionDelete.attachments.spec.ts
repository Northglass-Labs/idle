import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    tx,
    callbacks,
    deleteAttachmentObjectsMock,
    requestAttachmentDeletionDrainMock,
    allocateUserSeqMock,
    emitUpdateMock,
    disconnectSessionConnectionsMock,
    logMock,
    transactionState,
} = vi.hoisted(() => {
    const callbacks: Array<() => unknown> = [];
    const dm = () => vi.fn().mockResolvedValue({ count: 0 });
    return {
        callbacks,
        deleteAttachmentObjectsMock: vi.fn(),
        requestAttachmentDeletionDrainMock: vi.fn(),
        allocateUserSeqMock: vi.fn().mockResolvedValue(1),
        emitUpdateMock: vi.fn(),
        disconnectSessionConnectionsMock: vi.fn().mockResolvedValue(undefined),
        logMock: vi.fn(),
        transactionState: { allocationsBeforeCallbacks: 0 },
        tx: {
            session: { findFirst: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
            attachment: { findMany: vi.fn(), deleteMany: dm() },
            attachmentDeletion: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
            sessionMessage: { deleteMany: dm() },
            usageReport: { deleteMany: dm() },
            accessKey: { deleteMany: dm() },
        },
    };
});

vi.mock('../../storage/inTx', () => ({
    inTx: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        transactionState.allocationsBeforeCallbacks = allocateUserSeqMock.mock.calls.length;
        for (const callback of callbacks.splice(0)) await callback();
        return result;
    }),
    afterTx: vi.fn((_tx: unknown, callback: () => unknown) => callbacks.push(callback)),
}));
vi.mock('../../storage/files', () => ({ deleteAttachmentObjects: deleteAttachmentObjectsMock }));
vi.mock('../attachments/attachmentDeletionOutbox', () => ({
    requestAttachmentDeletionDrain: requestAttachmentDeletionDrainMock,
}));
vi.mock('../events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: emitUpdateMock,
        disconnectSessionConnections: disconnectSessionConnectionsMock,
    },
    buildDeleteSessionUpdate: vi.fn(() => ({ type: 'delete-session' })),
}));
vi.mock('../../storage/seq', () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock('../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'random') }));
vi.mock('../../utils/log', () => ({ log: logMock }));

import { sessionDelete } from './sessionDelete';

describe('sessionDelete attachment lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbacks.splice(0);
        transactionState.allocationsBeforeCallbacks = 0;
        tx.attachment.findMany.mockResolvedValue([]);
    });

    it('durably records exact attachment refs before deleting their session ownership', async () => {
        tx.session.findFirst.mockResolvedValue({ id: 'session-1', accountId: 'account-1' });
        tx.attachment.findMany.mockResolvedValue([
            { ref: 'sessions/session-1/attachments/00000000-0000-4000-8000-000000000001.enc', size: 10 },
            { ref: 'sessions/session-1/attachments/00000000-0000-4000-8000-000000000002.enc', size: 20 },
        ]);

        const deleted = await sessionDelete({ uid: 'account-1' }, 'session-1');

        expect(deleted).toBe(true);
        expect(tx.attachment.findMany).toHaveBeenCalledWith({
            where: { sessionId: 'session-1', accountId: 'account-1' },
            select: { ref: true, size: true },
        });
        expect(tx.attachment.deleteMany).toHaveBeenCalledWith({
            where: { sessionId: 'session-1', accountId: 'account-1' },
        });
        expect(tx.attachmentDeletion.createMany).toHaveBeenCalledWith({
            data: [
                { ref: 'sessions/session-1/attachments/00000000-0000-4000-8000-000000000001.enc', size: 10 },
                { ref: 'sessions/session-1/attachments/00000000-0000-4000-8000-000000000002.enc', size: 20 },
            ],
            skipDuplicates: true,
        });
        expect(tx.attachmentDeletion.createMany.mock.invocationCallOrder[0])
            .toBeLessThan(tx.attachment.deleteMany.mock.invocationCallOrder[0]);
        expect(requestAttachmentDeletionDrainMock).toHaveBeenCalledOnce();
        expect(deleteAttachmentObjectsMock).not.toHaveBeenCalled();
        expect(tx.session.delete.mock.invocationCallOrder[0])
            .toBeGreaterThan(tx.attachment.deleteMany.mock.invocationCallOrder[0]);
    });

    it('does not inspect or delete attachment storage for a missing or unowned session', async () => {
        tx.session.findFirst.mockResolvedValue(null);

        const deleted = await sessionDelete({ uid: 'account-2' }, 'session-1');

        expect(deleted).toBe(false);
        expect(tx.attachment.findMany).not.toHaveBeenCalled();
        expect(tx.attachmentDeletion.createMany).not.toHaveBeenCalled();
        expect(requestAttachmentDeletionDrainMock).not.toHaveBeenCalled();
        expect(disconnectSessionConnectionsMock).toHaveBeenCalledWith('account-2', 'session-1');
    });

    it('commits deletion before sweeping the exact session room', async () => {
        tx.session.findFirst.mockResolvedValue({
            id: 'session-1',
            accountId: 'account-1',
            createdAt: new Date(0),
        });

        await expect(sessionDelete({ uid: 'account-1' }, 'session-1')).resolves.toBe(true);

        expect(tx.session.delete.mock.invocationCallOrder[0])
            .toBeLessThan(disconnectSessionConnectionsMock.mock.invocationCallOrder[0]);
        expect(emitUpdateMock.mock.invocationCallOrder[0])
            .toBeLessThan(disconnectSessionConnectionsMock.mock.invocationCallOrder[0]);
        expect(disconnectSessionConnectionsMock).toHaveBeenCalledWith('account-1', 'session-1');
    });

    it('propagates a room-sweep failure after durable deletion', async () => {
        tx.session.findFirst.mockResolvedValue({
            id: 'session-1',
            accountId: 'account-1',
            createdAt: new Date(0),
        });
        disconnectSessionConnectionsMock.mockRejectedValueOnce(new Error('adapter unavailable'));

        await expect(sessionDelete({ uid: 'account-1' }, 'session-1'))
            .rejects.toThrow('adapter unavailable');

        expect(tx.session.delete).toHaveBeenCalledWith({ where: { id: 'session-1' } });
    });

    it('deletes an attachment-free owned session without queuing storage work', async () => {
        tx.session.findFirst.mockResolvedValue({ id: 'session-1', accountId: 'account-1' });
        tx.attachment.findMany.mockResolvedValue([]);

        const deleted = await sessionDelete({ uid: 'account-1' }, 'session-1');

        expect(deleted).toBe(true);
        expect(tx.attachmentDeletion.createMany).not.toHaveBeenCalled();
        expect(requestAttachmentDeletionDrainMock).not.toHaveBeenCalled();
        expect(tx.session.delete).toHaveBeenCalledWith({ where: { id: 'session-1' } });
    });

    it('allocates the delete update sequence transactionally before post-commit work', async () => {
        tx.session.findFirst.mockResolvedValue({
            id: 'session-1',
            accountId: 'account-1',
            createdAt: new Date(0),
        });

        await expect(sessionDelete({ uid: 'account-1' }, 'session-1')).resolves.toBe(true);

        expect(transactionState.allocationsBeforeCallbacks).toBe(1);
        expect(allocateUserSeqMock).toHaveBeenCalledWith('account-1', tx);
        expect(emitUpdateMock).toHaveBeenCalledOnce();
    });

    it('keeps delete diagnostics free of account, session, attachment, and payload identifiers', async () => {
        tx.session.findFirst.mockResolvedValue({
            id: 'session-private-1',
            accountId: 'account-private-1',
            createdAt: new Date(0),
        });
        tx.attachment.findMany.mockResolvedValue([{ ref: 'private/attachment/ref.enc', size: 1 }]);

        await sessionDelete({ uid: 'account-private-1' }, 'session-private-1');

        const diagnostics = JSON.stringify(logMock.mock.calls);
        expect(diagnostics).not.toContain('account-private-1');
        expect(diagnostics).not.toContain('session-private-1');
        expect(diagnostics).not.toContain('private/attachment/ref.enc');
        expect(diagnostics).not.toContain('updatePayload');
        expect(diagnostics).not.toContain('delete-session');
    });
});
