import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { requestAttachmentDeletionDrain } from "@/app/attachments/attachmentDeletionOutbox";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    const deleted = await inTx(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            }
        });

        if (!session) {
            log({ module: 'session-delete' }, 'Session delete skipped');
            return false;
        }

        // The attachment table is the bounded source of truth. Capture exact
        // object keys before deleting rows so cleanup never lists an unbounded
        // storage prefix after the transaction commits.
        const attachments = await tx.attachment.findMany({
            where: { sessionId, accountId: ctx.uid },
            select: { ref: true, size: true },
        });

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations

        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });
        log({ module: 'session-delete', deletedCount: deletedMessages.count }, 'Deleted session messages');

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId }
        });
        log({ module: 'session-delete', deletedCount: deletedReports.count }, 'Deleted usage reports');

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId }
        });
        log({ module: 'session-delete', deletedCount: deletedAccessKeys.count }, 'Deleted access keys');

        if (attachments.length > 0) {
            // Preserve the only exact object references in the durable outbox
            // before deleting their account/session ownership.
            await tx.attachmentDeletion.createMany({
                data: attachments.map((attachment) => ({
                    ref: attachment.ref,
                    size: attachment.size,
                })),
                skipDuplicates: true,
            });
        }
        await tx.attachment.deleteMany({ where: { sessionId, accountId: ctx.uid } });

        // 4. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });
        log({ module: 'session-delete' }, 'Session deleted');

        // Reserve the update sequence in the deletion transaction. If sequence
        // allocation fails, the deletion rolls back instead of losing the only
        // synchronization event connected clients can consume.
        const updSeq = await allocateUserSeq(ctx.uid, tx);
        const updatePayload = buildDeleteSessionUpdate(
            sessionId,
            updSeq,
            randomKeyNaked(12),
            session.createdAt,
        );

        // Independent callbacks ensure a cleanup wake-up failure cannot
        // suppress the synchronization event.
        if (attachments.length > 0) {
            afterTx(tx, () => requestAttachmentDeletionDrain());
        }
        afterTx(tx, () => {
            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return true;
    });

    // The database commit is the revocation boundary: it blocks new scoped
    // handshakes. Sweep the exact room afterward so every existing capability
    // and derived RPC registration is disconnected before this call succeeds.
    // This also runs for a missing row so retrying a prior failed sweep repairs
    // the committed deletion.
    await eventRouter.disconnectSessionConnections(ctx.uid, sessionId);

    return deleted;
}
