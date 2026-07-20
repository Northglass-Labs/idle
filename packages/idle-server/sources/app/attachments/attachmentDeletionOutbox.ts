import { db } from '@/storage/db';
import { deleteAttachmentObjects } from '@/storage/files';
import { log } from '@/utils/log';
import { onShutdown } from '@/utils/shutdown';
import { inTx } from '@/storage/inTx';
import { releaseAttachmentStorage } from './attachmentStorageBudget';

const DELETE_BATCH_SIZE = 100;
const MAX_BATCHES_PER_DRAIN = 20;
const RETRY_INTERVAL_MS = 60_000;

let activeDrain: Promise<void> | null = null;
let workerTimer: NodeJS.Timeout | null = null;
let workerStopping = false;

async function runDrain(): Promise<void> {
    for (let batchNumber = 0; batchNumber < MAX_BATCHES_PER_DRAIN; batchNumber += 1) {
        const pending = await db.attachmentDeletion.findMany({
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: DELETE_BATCH_SIZE,
            select: { id: true, ref: true },
        });
        if (pending.length === 0) return;

        const ids = pending.map((row) => row.id);
        try {
            // Missing objects are a successful idempotent delete. If a process
            // exits after this call but before the database acknowledgement,
            // the retained rows safely drive the same exact deletion again.
            await deleteAttachmentObjects(pending.map((row) => row.ref));
        } catch {
            await db.attachmentDeletion.updateMany({
                where: { id: { in: ids } },
                data: {
                    attempts: { increment: 1 },
                    lastAttemptAt: new Date(),
                },
            });
            log(
                { module: 'attachment-deletion-outbox', pendingCount: pending.length },
                'Attachment object deletion deferred for retry',
            );
            return;
        }

        // A storage success is acknowledged last. The queue acknowledgement
        // and budget release share one transaction, so a crash can only cause
        // a harmless repeat object delete, never a double decrement.
        await inTx(async (tx) => {
            const acknowledged = await tx.attachmentDeletion.findMany({
                where: { id: { in: ids } },
                select: { id: true, size: true },
            });
            if (acknowledged.length === 0) return;
            const acknowledgedIds = acknowledged.map((row) => row.id);
            const deleted = await tx.attachmentDeletion.deleteMany({
                where: { id: { in: acknowledgedIds } },
            });
            if (deleted.count !== acknowledged.length) {
                throw new Error('Attachment deletion acknowledgement changed');
            }
            const charged = acknowledged.filter((row) => row.size !== null);
            const bytes = charged.reduce((sum, row) => sum + BigInt(row.size!), 0n);
            await releaseAttachmentStorage(tx, bytes, BigInt(charged.length));
        });
    }
}

export function drainAttachmentDeletionOutbox(): Promise<void> {
    if (activeDrain) return activeDrain;
    activeDrain = runDrain().finally(() => {
        activeDrain = null;
    });
    return activeDrain;
}

export function requestAttachmentDeletionDrain(): void {
    if (workerStopping) return;
    void drainAttachmentDeletionOutbox().catch(() => {
        // The database row remains the source of truth. Avoid logging backend
        // error text because storage failures can contain deployment details.
        log(
            { module: 'attachment-deletion-outbox' },
            'Attachment deletion retry worker could not read or acknowledge its queue',
        );
    });
}

export function startAttachmentDeletionWorker(): void {
    if (workerTimer || workerStopping) return;
    requestAttachmentDeletionDrain();
    workerTimer = setInterval(requestAttachmentDeletionDrain, RETRY_INTERVAL_MS);
    workerTimer.unref();
    onShutdown('attachment-deletion-outbox', async () => {
        workerStopping = true;
        if (workerTimer) {
            clearInterval(workerTimer);
            workerTimer = null;
        }
        const drain = activeDrain;
        if (drain) {
            await drain;
        }
    });
}
