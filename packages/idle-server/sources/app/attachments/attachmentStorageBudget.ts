import type { Tx } from '@/storage/inTx';

const DEFAULT_STORAGE_LIMIT_BYTES = 10n * 1024n * 1024n * 1024n;
const DEFAULT_STORAGE_LIMIT_OBJECTS = 2_000n;
const MIN_STORAGE_LIMIT_BYTES = 1n;
const MAX_STORAGE_LIMIT_BYTES = 1024n * 1024n * 1024n * 1024n * 1024n;
const MAX_STORAGE_LIMIT_OBJECTS = 10_000_000n;

export type AttachmentStorageLimits = {
    bytes: bigint;
    objects: bigint;
};

function parsePositiveInteger(
    value: string | undefined,
    fallback: bigint,
    minimum: bigint,
    maximum: bigint,
): bigint | null {
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]{0,18}$/.test(value)) return null;
    const parsed = BigInt(value);
    return parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function readAttachmentStorageLimits(): AttachmentStorageLimits | null {
    const bytes = parsePositiveInteger(
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES,
        DEFAULT_STORAGE_LIMIT_BYTES,
        MIN_STORAGE_LIMIT_BYTES,
        MAX_STORAGE_LIMIT_BYTES,
    );
    const objects = parsePositiveInteger(
        process.env.IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS,
        DEFAULT_STORAGE_LIMIT_OBJECTS,
        1n,
        MAX_STORAGE_LIMIT_OBJECTS,
    );
    return bytes !== null && objects !== null ? { bytes, objects } : null;
}

export async function claimAttachmentStorage(tx: Tx, size: number): Promise<boolean> {
    const limits = readAttachmentStorageLimits();
    const requested = BigInt(size);
    if (!limits || requested > limits.bytes) return false;

    const claimed = await tx.attachmentStorageBudget.updateMany({
        where: {
            id: 'attachments',
            accountedBytes: { lte: limits.bytes - requested },
            objectCount: { lt: limits.objects },
        },
        data: {
            accountedBytes: { increment: requested },
            objectCount: { increment: 1n },
        },
    });
    return claimed.count === 1;
}

export async function releaseAttachmentStorage(
    tx: Tx,
    bytes: bigint,
    objects: bigint,
): Promise<void> {
    if (bytes === 0n && objects === 0n) return;
    if (bytes < 0n || objects < 0n) {
        throw new Error('Attachment storage release is invalid');
    }

    const released = await tx.attachmentStorageBudget.updateMany({
        where: {
            id: 'attachments',
            accountedBytes: { gte: bytes },
            objectCount: { gte: objects },
        },
        data: {
            accountedBytes: { decrement: bytes },
            objectCount: { decrement: objects },
        },
    });
    if (released.count !== 1) {
        throw new Error('Attachment storage budget is inconsistent');
    }
}
