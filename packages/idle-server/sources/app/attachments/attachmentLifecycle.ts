import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { randomUUID } from 'crypto';
import {
    claimAttachmentStorage,
    releaseAttachmentStorage,
} from './attachmentStorageBudget';

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const ATTACHMENT_RESERVATION_TTL_MS = 15 * 60 * 1000;
export const SESSION_ATTACHMENT_COUNT_LIMIT = 200;
export const SESSION_ATTACHMENT_BYTE_LIMIT = 1024 * 1024 * 1024;
export const ACCOUNT_ATTACHMENT_COUNT_LIMIT = 2_000;
export const ACCOUNT_ATTACHMENT_BYTE_LIMIT = 10 * 1024 * 1024 * 1024;
export const EXPIRED_ATTACHMENT_CLEANUP_BATCH = 100;

type AttachmentStatus = 'PENDING' | 'WRITING' | 'UPLOADED';
export type AttachmentTransport = 'DIRECT' | 'RELAY';

export type AttachmentRecord = {
    id: string;
    accountId: string;
    sessionId: string;
    ref: string;
    size: number;
    status: AttachmentStatus;
    transport: AttachmentTransport;
    expiresAt: Date;
    uploadedAt: Date | null;
};

export type AttachmentLifecycleErrorCode =
    | 'NOT_FOUND'
    | 'INVALID'
    | 'QUOTA'
    | 'EXPIRED'
    | 'CONFLICT'
    | 'SIZE_MISMATCH';

export class AttachmentLifecycleError extends Error {
    constructor(public readonly code: AttachmentLifecycleErrorCode, message: string) {
        super(message);
        this.name = 'AttachmentLifecycleError';
    }
}

function validateSize(size: number): void {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_SIZE) {
        throw new AttachmentLifecycleError('INVALID', 'Invalid attachment size');
    }
}

function validateRef(sessionId: string, ref: string): void {
    const prefix = `sessions/${sessionId}/attachments/`;
    const file = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/.test(file)) {
        throw new AttachmentLifecycleError('INVALID', 'Invalid attachment ref');
    }
}

async function assertSessionOwner(tx: Tx, accountId: string, sessionId: string): Promise<void> {
    const session = await tx.session.findFirst({
        where: { id: sessionId, accountId },
        select: { id: true },
    });
    if (!session) {
        throw new AttachmentLifecycleError('NOT_FOUND', 'Session not found');
    }
}

export async function assertAttachmentSessionOwner(accountId: string, sessionId: string): Promise<void> {
    const session = await db.session.findFirst({
        where: { id: sessionId, accountId },
        select: { id: true },
    });
    if (!session) {
        throw new AttachmentLifecycleError('NOT_FOUND', 'Session not found');
    }
}

async function assertQuota(tx: Tx, accountId: string, sessionId: string, size: number): Promise<void> {
    const [sessionCount, sessionBytes, accountCount, accountBytes] = await Promise.all([
        tx.attachment.count({ where: { sessionId } }),
        tx.attachment.aggregate({ where: { sessionId }, _sum: { size: true } }),
        tx.attachment.count({ where: { accountId } }),
        tx.attachment.aggregate({ where: { accountId }, _sum: { size: true } }),
    ]);

    if (sessionCount >= SESSION_ATTACHMENT_COUNT_LIMIT
        || (sessionBytes._sum.size ?? 0) + size > SESSION_ATTACHMENT_BYTE_LIMIT
        || accountCount >= ACCOUNT_ATTACHMENT_COUNT_LIMIT
        || (accountBytes._sum.size ?? 0) + size > ACCOUNT_ATTACHMENT_BYTE_LIMIT) {
        throw new AttachmentLifecycleError('QUOTA', 'Attachment quota exceeded');
    }
}

export async function reserveAttachment(
    accountId: string,
    sessionId: string,
    size: number,
    transport: AttachmentTransport = 'DIRECT',
): Promise<AttachmentRecord> {
    validateSize(size);
    if (transport !== 'DIRECT' && transport !== 'RELAY') {
        throw new AttachmentLifecycleError('INVALID', 'Invalid attachment transport');
    }
    return inTx(async (tx) => {
        const now = new Date();
        await assertSessionOwner(tx, accountId, sessionId);
        await assertQuota(tx, accountId, sessionId, size);
        if (!await claimAttachmentStorage(tx, size)) {
            throw new AttachmentLifecycleError('QUOTA', 'Deployment attachment storage quota exceeded');
        }

        const id = randomUUID();
        const ref = `sessions/${sessionId}/attachments/${id}.enc`;
        return tx.attachment.create({
            data: {
                id,
                accountId,
                sessionId,
                ref,
                size,
                status: 'PENDING',
                transport,
                expiresAt: new Date(now.getTime() + ATTACHMENT_RESERVATION_TTL_MS),
            },
        }) as Promise<AttachmentRecord>;
    });
}

export async function getOwnedAttachment(accountId: string, sessionId: string, ref: string): Promise<AttachmentRecord> {
    validateRef(sessionId, ref);
    const attachment = await db.attachment.findFirst({ where: { accountId, sessionId, ref } });
    if (!attachment) {
        throw new AttachmentLifecycleError('NOT_FOUND', 'Attachment not found');
    }
    return attachment as AttachmentRecord;
}

export async function claimLocalAttachmentBeforeBody(
    accountId: string,
    sessionId: string,
    ref: string,
): Promise<AttachmentRecord> {
    validateRef(sessionId, ref);
    return inTx(async (tx) => {
        const attachment = await tx.attachment.findFirst({ where: { accountId, sessionId, ref } });
        if (!attachment) throw new AttachmentLifecycleError('NOT_FOUND', 'Attachment not found');
        validateSize(attachment.size);
        if (attachment.transport !== 'RELAY') {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment capability uses another transport');
        }
        if (attachment.expiresAt <= new Date()) {
            throw new AttachmentLifecycleError('EXPIRED', 'Attachment reservation expired');
        }
        if (attachment.status !== 'PENDING') {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment reservation already consumed');
        }
        const claimed = await tx.attachment.updateMany({
            where: {
                id: attachment.id,
                accountId,
                status: 'PENDING',
                transport: 'RELAY',
                expiresAt: { gt: new Date() },
            },
            data: { status: 'WRITING' },
        });
        if (claimed.count !== 1) {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment reservation already consumed');
        }
        return { ...attachment, status: 'WRITING' } as AttachmentRecord;
    });
}

export async function completeLocalAttachment(accountId: string, attachmentId: string): Promise<void> {
    const completed = await db.attachment.updateMany({
        where: { id: attachmentId, accountId, status: 'WRITING' },
        data: { status: 'UPLOADED', uploadedAt: new Date() },
    });
    if (completed.count !== 1) {
        throw new AttachmentLifecycleError('CONFLICT', 'Attachment upload could not be completed');
    }
}

export async function releaseLocalAttachment(accountId: string, attachmentId: string): Promise<void> {
    await deleteReservationAndRelease(accountId, attachmentId, 'WRITING');
}

export async function cancelPendingAttachment(accountId: string, attachmentId: string): Promise<void> {
    await deleteReservationAndRelease(accountId, attachmentId, 'PENDING');
}

async function deleteReservationAndRelease(
    accountId: string,
    attachmentId: string,
    status: 'PENDING' | 'WRITING',
): Promise<void> {
    await inTx(async (tx) => {
        const attachment = await tx.attachment.findFirst({
            where: { id: attachmentId, accountId, status },
            select: { id: true, size: true },
        });
        if (!attachment) return;
        const deleted = await tx.attachment.deleteMany({
            where: { id: attachment.id, accountId, status },
        });
        if (deleted.count !== 1) return;
        await releaseAttachmentStorage(tx, BigInt(attachment.size), 1n);
    });
}

export async function confirmS3Attachment(
    accountId: string,
    sessionId: string,
    ref: string,
    actualSize: number,
): Promise<AttachmentRecord> {
    validateSize(actualSize);
    validateRef(sessionId, ref);
    return inTx(async (tx) => {
        const attachment = await tx.attachment.findFirst({ where: { accountId, sessionId, ref } });
        if (!attachment) throw new AttachmentLifecycleError('NOT_FOUND', 'Attachment not found');
        if (attachment.size !== actualSize) {
            throw new AttachmentLifecycleError('SIZE_MISMATCH', 'Attachment size does not match reservation');
        }
        if (attachment.transport !== 'DIRECT') {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment capability uses another transport');
        }
        if (attachment.status === 'UPLOADED') return attachment as AttachmentRecord;
        if (attachment.status !== 'PENDING') {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment upload is incomplete');
        }
        const uploadedAt = new Date();
        const updated = await tx.attachment.updateMany({
            where: { id: attachment.id, accountId, status: 'PENDING', transport: 'DIRECT' },
            data: { status: 'UPLOADED', uploadedAt },
        });
        if (updated.count !== 1) {
            throw new AttachmentLifecycleError('CONFLICT', 'Attachment reservation changed');
        }
        return { ...attachment, status: 'UPLOADED', uploadedAt } as AttachmentRecord;
    });
}

export async function adoptLegacyAttachment(
    accountId: string,
    sessionId: string,
    ref: string,
    actualSize: number,
): Promise<AttachmentRecord> {
    validateSize(actualSize);
    validateRef(sessionId, ref);
    return inTx(async (tx) => {
        const existing = await tx.attachment.findFirst({ where: { accountId, sessionId, ref } });
        if (existing) return existing as AttachmentRecord;

        const now = new Date();
        await assertSessionOwner(tx, accountId, sessionId);
        await assertQuota(tx, accountId, sessionId, actualSize);
        if (!await claimAttachmentStorage(tx, actualSize)) {
            throw new AttachmentLifecycleError('QUOTA', 'Deployment attachment storage quota exceeded');
        }
        const id = ref.slice(ref.lastIndexOf('/') + 1, -'.enc'.length);
        return tx.attachment.create({
            data: {
                id,
                accountId,
                sessionId,
                ref,
                size: actualSize,
                status: 'UPLOADED',
                transport: 'DIRECT',
                expiresAt: now,
                uploadedAt: now,
            },
        }) as Promise<AttachmentRecord>;
    });
}

export async function listExpiredAttachmentReservations(accountId: string): Promise<AttachmentRecord[]> {
    return db.attachment.findMany({
        where: {
            accountId,
            transport: 'RELAY',
            status: 'PENDING',
            expiresAt: { lte: new Date() },
        },
        orderBy: { expiresAt: 'asc' },
        take: EXPIRED_ATTACHMENT_CLEANUP_BATCH,
    }) as Promise<AttachmentRecord[]>;
}

export async function deleteExpiredAttachmentReservations(accountId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (ids.length > EXPIRED_ATTACHMENT_CLEANUP_BATCH) {
        throw new AttachmentLifecycleError('INVALID', 'Expired attachment cleanup batch is too large');
    }
    await inTx(async (tx) => {
        const where = {
            id: { in: ids },
            accountId,
            transport: 'RELAY' as const,
            status: 'PENDING' as const,
            expiresAt: { lte: new Date() },
        };
        const attachments = await tx.attachment.findMany({
            where,
            select: { id: true, size: true },
        });
        if (attachments.length === 0) return;
        const attachmentIds = attachments.map((attachment) => attachment.id);
        const deleted = await tx.attachment.deleteMany({
            where: { ...where, id: { in: attachmentIds } },
        });
        if (deleted.count !== attachments.length) {
            throw new AttachmentLifecycleError('CONFLICT', 'Expired attachment cleanup changed');
        }
        const bytes = attachments.reduce((sum, attachment) => sum + BigInt(attachment.size), 0n);
        await releaseAttachmentStorage(tx, bytes, BigInt(attachments.length));
    });
}
