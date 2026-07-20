import { describe, it, expect, vi, beforeEach } from "vitest";

// inTx simply runs the callback with our mock transaction client.
const {
    accountAdmissionReleaseMock,
    mockTx,
    callbacks,
    authMock,
    requestAttachmentDeletionDrainMock,
} = vi.hoisted(() => {
    const dm = () => vi.fn().mockResolvedValue({ count: 0 });
    const callbacks: Array<() => void> = [];
    return {
        callbacks,
        accountAdmissionReleaseMock: vi.fn().mockResolvedValue(undefined),
        authMock: {
            invalidateUserTokens: vi.fn(),
            invalidateAccountCache: vi.fn(),
        },
        requestAttachmentDeletionDrainMock: vi.fn(),
        mockTx: {
            account: { findUnique: vi.fn(), delete: vi.fn().mockResolvedValue({}) },
            session: { findMany: vi.fn(), deleteMany: dm() },
            sessionMessage: { deleteMany: dm() },
            usageReport: { deleteMany: dm() },
            accessKey: { deleteMany: dm() },
            machine: { deleteMany: dm() },
            accountPushToken: { deleteMany: dm() },
            uploadedFile: { deleteMany: dm() },
            artifact: { deleteMany: dm() },
            userRelationship: { deleteMany: dm() },
            userFeedItem: { deleteMany: dm() },
            userKVStore: { deleteMany: dm() },
            terminalAuthRequest: { deleteMany: dm() },
            accountAuthRequest: { deleteMany: dm() },
            githubUser: { deleteMany: dm() },
            attachment: { findMany: vi.fn(), deleteMany: dm() },
            attachmentDeletion: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
        },
    };
});

// Relative paths required — tsconfig aliases ("@/...") don't resolve in vi.mock.
vi.mock("../../storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const result = await fn(mockTx);
        for (const callback of callbacks.splice(0)) callback();
        return result;
    }),
    afterTx: vi.fn((_tx: unknown, callback: () => void) => callbacks.push(callback)),
}));
vi.mock("../../utils/log", () => ({ log: vi.fn() }));
vi.mock("../auth/auth", () => ({ auth: authMock }));
vi.mock("../auth/accountAdmission", () => ({
    releaseAccountAdmission: accountAdmissionReleaseMock,
}));
vi.mock("../attachments/attachmentDeletionOutbox", () => ({
    requestAttachmentDeletionDrain: requestAttachmentDeletionDrainMock,
}));

import { accountDelete } from "./accountDelete";

describe("accountDelete", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbacks.splice(0);
        mockTx.session.findMany.mockResolvedValue([]);
        mockTx.attachment.findMany.mockResolvedValue([]);
    });

    it("returns false and deletes nothing when the account does not exist", async () => {
        mockTx.account.findUnique.mockResolvedValue(null);

        const result = await accountDelete({ uid: "missing" });

        expect(result).toBe(false);
        expect(mockTx.account.delete).not.toHaveBeenCalled();
        expect(mockTx.session.deleteMany).not.toHaveBeenCalled();
        expect(authMock.invalidateUserTokens).not.toHaveBeenCalled();
        expect(authMock.invalidateAccountCache).not.toHaveBeenCalled();
    });

    it("deletes all related data, the account, and the linked GitHub profile", async () => {
        mockTx.account.findUnique.mockResolvedValue({ githubUserId: "gh1" });
        mockTx.session.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
        mockTx.attachment.findMany.mockResolvedValue([
            { ref: "sessions/s1/attachments/00000000-0000-4000-8000-000000000001.enc", size: 10 },
            { ref: "sessions/s2/attachments/00000000-0000-4000-8000-000000000002.enc", size: 20 },
        ]);

        const result = await accountDelete({ uid: "acc1" });

        expect(result).toBe(true);
        expect(mockTx.accessKey.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.sessionMessage.deleteMany).toHaveBeenCalledWith({ where: { sessionId: { in: ["s1", "s2"] } } });
        expect(mockTx.usageReport.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.attachment.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.session.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.machine.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.accountPushToken.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.uploadedFile.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.artifact.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.userRelationship.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ fromUserId: "acc1" }, { toUserId: "acc1" }] } });
        expect(mockTx.userFeedItem.deleteMany).toHaveBeenCalledWith({ where: { userId: "acc1" } });
        expect(mockTx.userKVStore.deleteMany).toHaveBeenCalledWith({ where: { accountId: "acc1" } });
        expect(mockTx.terminalAuthRequest.deleteMany).toHaveBeenCalledWith({ where: { responseAccountId: "acc1" } });
        expect(mockTx.accountAuthRequest.deleteMany).toHaveBeenCalledWith({ where: { responseAccountId: "acc1" } });
        expect(mockTx.account.delete).toHaveBeenCalledWith({ where: { id: "acc1" } });
        expect(accountAdmissionReleaseMock).toHaveBeenCalledWith(mockTx);
        expect(mockTx.githubUser.deleteMany).toHaveBeenCalledWith({ where: { id: "gh1" } });
        expect(requestAttachmentDeletionDrainMock).toHaveBeenCalledOnce();
        expect(authMock.invalidateUserTokens).toHaveBeenCalledWith("acc1");
        expect(authMock.invalidateAccountCache).toHaveBeenCalledWith("acc1");

        // Account row must be removed only after its children.
        const accountDeleteOrder = mockTx.account.delete.mock.invocationCallOrder[0];
        const sessionDeleteOrder = mockTx.session.deleteMany.mock.invocationCallOrder[0];
        expect(accountDeleteOrder).toBeGreaterThan(sessionDeleteOrder);
        expect(accountAdmissionReleaseMock.mock.invocationCallOrder[0]).toBeGreaterThan(accountDeleteOrder);
    });

    it("durably records attachment refs before deleting their database ownership", async () => {
        mockTx.account.findUnique.mockResolvedValue({ githubUserId: null });
        mockTx.session.findMany.mockResolvedValue([{ id: "s1" }]);
        mockTx.attachment.findMany.mockResolvedValue([
            { ref: "sessions/s1/attachments/00000000-0000-4000-8000-000000000001.enc", size: 10 },
            { ref: "sessions/s1/attachments/00000000-0000-4000-8000-000000000002.enc", size: 20 },
        ]);

        await accountDelete({ uid: "acc1" });

        expect(mockTx.attachmentDeletion.createMany).toHaveBeenCalledWith({
            data: [
                { ref: "sessions/s1/attachments/00000000-0000-4000-8000-000000000001.enc", size: 10 },
                { ref: "sessions/s1/attachments/00000000-0000-4000-8000-000000000002.enc", size: 20 },
            ],
            skipDuplicates: true,
        });
        expect(mockTx.attachmentDeletion.createMany.mock.invocationCallOrder[0])
            .toBeLessThan(mockTx.attachment.deleteMany.mock.invocationCallOrder[0]);
    });

    it("skips session messages with no sessions and skips GitHub when unlinked", async () => {
        mockTx.account.findUnique.mockResolvedValue({ githubUserId: null });
        mockTx.session.findMany.mockResolvedValue([]);

        const result = await accountDelete({ uid: "acc2" });

        expect(result).toBe(true);
        expect(mockTx.sessionMessage.deleteMany).not.toHaveBeenCalled();
        expect(mockTx.githubUser.deleteMany).not.toHaveBeenCalled();
        expect(mockTx.attachmentDeletion.createMany).not.toHaveBeenCalled();
        expect(requestAttachmentDeletionDrainMock).not.toHaveBeenCalled();
        expect(mockTx.account.delete).toHaveBeenCalledWith({ where: { id: "acc2" } });
    });
});
