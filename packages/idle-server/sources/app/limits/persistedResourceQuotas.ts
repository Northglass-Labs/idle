import type { Prisma } from '@prisma/client';

/**
 * Per-account persisted-resource limits.
 *
 * These are deliberately product constants rather than deployment settings:
 * every hosted and self-hosted relay gets the same security boundary, and an
 * operator cannot accidentally disable it with a missing environment value.
 * Existing rows are never deleted. Accounts above a limit may keep using and
 * deleting their existing resources; only a new allocation or inactive-to-
 * active transition is refused until the account is back below the limit.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 1_000;
export const MAX_ACTIVE_SESSIONS_PER_ACCOUNT = 100;
export const MAX_MACHINES_PER_ACCOUNT = 100;
export const MAX_ACTIVE_MACHINES_PER_ACCOUNT = 25;
export const MAX_KV_ROWS_PER_ACCOUNT = 1_000;
export const MAX_MESSAGES_PER_SESSION = 20_000;
export const MAX_MESSAGES_PER_ACCOUNT = 100_000;
// Message content is stored as standard-base64 text in PostgreSQL JSON. These
// quotas count the UTF-8 bytes of that retained ciphertext string, not the
// smaller decoded payload, so the durable database budget is conservative.
export const MAX_MESSAGE_BYTES_PER_SESSION = 512 * 1024 * 1024;
export const MAX_MESSAGE_BYTES_PER_ACCOUNT = 1024 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_ACCOUNT = 200;

export const MACHINE_LIST_LIMIT = MAX_MACHINES_PER_ACCOUNT;

type SessionQuotaClient = Pick<Prisma.TransactionClient, 'session'>;
type KVQuotaClient = Pick<Prisma.TransactionClient, 'userKVStore'>;
type MessageQuotaClient = Pick<Prisma.TransactionClient, 'sessionMessage'>;
type ArtifactQuotaClient = Pick<Prisma.TransactionClient, 'artifact'>;

export type MessageStorageQuotaStatus =
    | 'ok'
    | 'session-limit'
    | 'account-limit'
    | 'session-byte-limit'
    | 'account-byte-limit';

export async function getMessageStorageQuotaStatus(
    tx: MessageQuotaClient,
    accountId: string,
    sessionId: string,
    newRows: number,
    newContentBytes: number,
): Promise<MessageStorageQuotaStatus> {
    if (
        !Number.isSafeInteger(newRows)
        || newRows < 0
        || !Number.isSafeInteger(newContentBytes)
        || newContentBytes < 0
        || (newRows === 0) !== (newContentBytes === 0)
    ) {
        throw new Error('Invalid message storage allocation');
    }
    if (newRows === 0) return 'ok';

    const [sessionRows, sessionBytes] = await Promise.all([
        tx.sessionMessage.count({ where: { sessionId } }),
        tx.sessionMessage.aggregate({
            where: { sessionId },
            _sum: { contentBytes: true },
        }),
    ]);
    if (sessionRows + newRows > MAX_MESSAGES_PER_SESSION) {
        return 'session-limit';
    }
    if ((sessionBytes._sum.contentBytes ?? 0) + newContentBytes > MAX_MESSAGE_BYTES_PER_SESSION) {
        return 'session-byte-limit';
    }

    const [accountRows, accountBytes] = await Promise.all([
        tx.sessionMessage.count({
            where: { session: { accountId } },
        }),
        tx.sessionMessage.aggregate({
            where: { session: { accountId } },
            _sum: { contentBytes: true },
        }),
    ]);
    if (accountRows + newRows > MAX_MESSAGES_PER_ACCOUNT) {
        return 'account-limit';
    }
    if ((accountBytes._sum.contentBytes ?? 0) + newContentBytes > MAX_MESSAGE_BYTES_PER_ACCOUNT) {
        return 'account-byte-limit';
    }
    return 'ok';
}

export async function canAllocateArtifactRows(
    tx: ArtifactQuotaClient,
    accountId: string,
    newRows: number,
): Promise<boolean> {
    if (newRows <= 0) return true;
    const existingRows = await tx.artifact.count({ where: { accountId } });
    return existingRows + newRows <= MAX_ARTIFACTS_PER_ACCOUNT;
}

export async function canAllocateKVRows(
    tx: KVQuotaClient,
    accountId: string,
    newRows: number,
): Promise<boolean> {
    if (newRows <= 0) return true;
    const existingRows = await tx.userKVStore.count({ where: { accountId } });
    return existingRows + newRows <= MAX_KV_ROWS_PER_ACCOUNT;
}

export type SessionReactivationResult =
    | 'activated'
    | 'already-active'
    | 'active-limit'
    | 'missing';

/**
 * Reactivate one session inside the caller's Serializable transaction.
 * Message persistence remains independent: reaching the presence cap must not
 * lose an encrypted user message, it only leaves the older session inactive.
 */
export async function reactivateSessionWithinQuota(
    tx: SessionQuotaClient,
    accountId: string,
    sessionId: string,
    timestamp: number,
): Promise<SessionReactivationResult> {
    const session = await tx.session.findFirst({
        where: { id: sessionId, accountId },
        select: { active: true },
    });
    if (!session) {
        return 'missing';
    }

    if (!session.active) {
        const activeSessions = await tx.session.count({
            where: { accountId, active: true },
        });
        if (activeSessions >= MAX_ACTIVE_SESSIONS_PER_ACCOUNT) {
            return 'active-limit';
        }
    }

    const { count } = await tx.session.updateMany({
        where: { id: sessionId, accountId, active: session.active },
        data: { lastActiveAt: new Date(timestamp), active: true },
    });
    if (count === 0) {
        // Under Serializable isolation a concurrent transition retries the
        // transaction. This fallback is fail-closed for test doubles/adapters
        // that report a lost compare-and-swap without surfacing a conflict.
        return 'missing';
    }
    return session.active ? 'already-active' : 'activated';
}

export function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'P2002';
}
