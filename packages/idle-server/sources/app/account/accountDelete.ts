import { Context } from "@/context";
import { afterTx, inTx } from "@/storage/inTx";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { requestAttachmentDeletionDrain } from "@/app/attachments/attachmentDeletionOutbox";
import { releaseAccountAdmission } from "@/app/auth/accountAdmission";

/**
 * Permanently delete an account and every row tied to it.
 *
 * Required by App Store Guideline 5.1.1(v): any app that supports account
 * creation must offer in-app account deletion. An Idle "account" is a libsodium
 * keypair whose public key plus all session / message / machine / file / usage
 * data live on the relay. Deletion wipes every owned row and then the account;
 * exact attachment refs remain only as content-free cleanup jobs until their
 * encrypted storage objects have been removed.
 *
 * Most relations have no `onDelete: Cascade`, so children are deleted explicitly
 * before the account (order matters to avoid foreign-key violations). The few
 * cascade relations are deleted here too for clarity. Idempotent: a missing
 * account is treated as already deleted and returns false.
 *
 * @returns true if an account was deleted, false if it did not exist.
 */
export async function accountDelete(ctx: Context): Promise<boolean> {
    return await inTx(async (tx) => {
        const uid = ctx.uid;

        const account = await tx.account.findUnique({
            where: { id: uid },
            select: { githubUserId: true },
        });
        if (!account) {
            return false;
        }

        // Session children need the account's session ids first (FK order).
        const sessions = await tx.session.findMany({
            where: { accountId: uid },
            select: { id: true },
        });
        const sessionIds = sessions.map((s) => s.id);
        const attachments = await tx.attachment.findMany({
            where: { accountId: uid },
            select: { ref: true, size: true },
        });

        // Children before parents to satisfy foreign-key constraints.
        await tx.accessKey.deleteMany({ where: { accountId: uid } });
        if (sessionIds.length > 0) {
            await tx.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
        }
        await tx.usageReport.deleteMany({ where: { accountId: uid } });
        if (attachments.length > 0) {
            // Commit exact object refs in the same transaction that removes
            // their owners. The independent outbox has no account/session FK,
            // so storage outages and process restarts cannot erase retry state.
            await tx.attachmentDeletion.createMany({
                data: attachments.map((attachment) => ({
                    ref: attachment.ref,
                    size: attachment.size,
                })),
                skipDuplicates: true,
            });
        }
        await tx.attachment.deleteMany({ where: { accountId: uid } });
        await tx.session.deleteMany({ where: { accountId: uid } });
        await tx.machine.deleteMany({ where: { accountId: uid } });
        await tx.accountPushToken.deleteMany({ where: { accountId: uid } });
        await tx.uploadedFile.deleteMany({ where: { accountId: uid } });
        await tx.artifact.deleteMany({ where: { accountId: uid } });
        await tx.userRelationship.deleteMany({ where: { OR: [{ fromUserId: uid }, { toUserId: uid }] } });
        await tx.userFeedItem.deleteMany({ where: { userId: uid } });
        await tx.userKVStore.deleteMany({ where: { accountId: uid } });
        // Pending auth requests reference this account via a nullable responseAccountId.
        await tx.terminalAuthRequest.deleteMany({ where: { responseAccountId: uid } });
        await tx.accountAuthRequest.deleteMany({ where: { responseAccountId: uid } });

        // The account row itself.
        await tx.account.delete({ where: { id: uid } });
        await releaseAccountAdmission(tx);

        // The linked GitHub profile is 1:1 (@unique) and now orphaned — drop it.
        if (account.githubUserId) {
            await tx.githubUser.deleteMany({ where: { id: account.githubUserId } });
        }

        afterTx(tx, () => {
            // Invalidate live token and existence caches immediately after
            // commit so a deleted account cannot remain usable.
            auth.invalidateUserTokens(uid);
            auth.invalidateAccountCache(uid);

            if (attachments.length > 0) requestAttachmentDeletionDrain();
        });

        log(
            { module: 'account-delete', attachmentCleanupCount: attachments.length },
            'Account rows deleted and attachment cleanup scheduled',
        );
        return true;
    });
}
