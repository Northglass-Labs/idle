import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
    MAX_ARTIFACTS_PER_ACCOUNT,
    MAX_KV_ROWS_PER_ACCOUNT,
    MAX_MESSAGE_BYTES_PER_ACCOUNT,
    MAX_MESSAGE_BYTES_PER_SESSION,
    MAX_MESSAGES_PER_ACCOUNT,
    MAX_MESSAGES_PER_SESSION,
    canAllocateArtifactRows,
    canAllocateKVRows,
    getMessageStorageQuotaStatus,
    reactivateSessionWithinQuota,
} from './persistedResourceQuotas';

describe('reactivateSessionWithinQuota', () => {
    const sessions: any[] = [];
    let txTail = Promise.resolve();
    const matches = (row: any, where: any) => (
        (where.id === undefined || row.id === where.id)
        && (where.accountId === undefined || row.accountId === where.accountId)
        && (where.active === undefined || row.active === where.active)
    );
    const tx = {
        session: {
            findFirst: vi.fn(async ({ where }: any) => {
                const row = sessions.find((candidate) => matches(candidate, where));
                return row ? { ...row } : null;
            }),
            count: vi.fn(async ({ where }: any) => sessions.filter((row) => matches(row, where)).length),
            updateMany: vi.fn(async ({ where, data }: any) => {
                const row = sessions.find((candidate) => matches(candidate, where));
                if (!row) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }),
        },
    } as any;

    const addSession = (accountId: string, id: string, active: boolean) => {
        sessions.push({ id, accountId, active, lastActiveAt: new Date(0) });
    };

    const serial = async (fn: () => Promise<any>) => {
        let release!: () => void;
        const predecessor = txTail;
        txTail = new Promise<void>((resolve) => { release = resolve; });
        await predecessor;
        try {
            return await fn();
        } finally {
            release();
        }
    };

    beforeEach(() => {
        sessions.length = 0;
        txTail = Promise.resolve();
        vi.clearAllMocks();
    });

    it('leaves an inactive session inactive when its account is at the active cap', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT; index += 1) {
            addSession('account-a', `active-${index}`, true);
        }
        addSession('account-a', 'target', false);

        const result = await reactivateSessionWithinQuota(tx, 'account-a', 'target', 1234);

        expect(result).toBe('active-limit');
        expect(sessions.find((row) => row.id === 'target')).toMatchObject({ active: false });
        expect(tx.session.updateMany).not.toHaveBeenCalled();
    });

    it('scopes the count per account and activates below the cap', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT; index += 1) {
            addSession('account-b', `other-${index}`, true);
        }
        addSession('account-a', 'target', false);

        const result = await reactivateSessionWithinQuota(tx, 'account-a', 'target', 1234);

        expect(result).toBe('activated');
        expect(sessions.find((row) => row.id === 'target')).toMatchObject({
            active: true,
            lastActiveAt: new Date(1234),
        });
    });

    it('updates an already-active legacy session without applying the cap again', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT + 1; index += 1) {
            addSession('account-a', `active-${index}`, true);
        }

        const result = await reactivateSessionWithinQuota(tx, 'account-a', 'active-0', 5678);

        expect(result).toBe('already-active');
        expect(sessions.find((row) => row.id === 'active-0')?.lastActiveAt).toEqual(new Date(5678));
    });

    it('serializes two reactivations competing for one remaining slot', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT - 1; index += 1) {
            addSession('account-a', `active-${index}`, true);
        }
        addSession('account-a', 'target-one', false);
        addSession('account-a', 'target-two', false);

        const results = await Promise.all([
            serial(() => reactivateSessionWithinQuota(tx, 'account-a', 'target-one', 1)),
            serial(() => reactivateSessionWithinQuota(tx, 'account-a', 'target-two', 2)),
        ]);

        expect(results.sort()).toEqual(['activated', 'active-limit']);
        expect(sessions.filter((row) => row.accountId === 'account-a' && row.active)).toHaveLength(MAX_ACTIVE_SESSIONS_PER_ACCOUNT);
    });
});

describe('canAllocateKVRows', () => {
    it('bounds live values and tombstones per account while allowing updates', async () => {
        const count = vi.fn(async ({ where }: any) => (
            where.accountId === 'full' ? MAX_KV_ROWS_PER_ACCOUNT : 1
        ));
        const tx = { userKVStore: { count } } as any;

        await expect(canAllocateKVRows(tx, 'full', 1)).resolves.toBe(false);
        await expect(canAllocateKVRows(tx, 'full', 0)).resolves.toBe(true);
        await expect(canAllocateKVRows(tx, 'other', 1)).resolves.toBe(true);
        expect(count).toHaveBeenCalledWith({ where: { accountId: 'full' } });
    });
});

describe('getMessageStorageQuotaStatus', () => {
    it('enforces both the session and account row budgets for new messages', async () => {
        const count = vi.fn(async ({ where }: any) => (
            where.sessionId === 'full-session'
                ? MAX_MESSAGES_PER_SESSION
                : where.session?.accountId === 'full-account'
                    ? MAX_MESSAGES_PER_ACCOUNT
                    : 10
        ));
        const aggregate = vi.fn(async () => ({ _sum: { contentBytes: 0 } }));
        const tx = { sessionMessage: { count, aggregate } } as any;

        await expect(getMessageStorageQuotaStatus(tx, 'account-a', 'full-session', 1, 1))
            .resolves.toBe('session-limit');
        await expect(getMessageStorageQuotaStatus(tx, 'full-account', 'session-a', 1, 1))
            .resolves.toBe('account-limit');
        await expect(getMessageStorageQuotaStatus(tx, 'account-a', 'session-a', 1, 1))
            .resolves.toBe('ok');
        await expect(getMessageStorageQuotaStatus(tx, 'full-account', 'full-session', 0, 0))
            .resolves.toBe('ok');
    });

    it('enforces cumulative encrypted-message byte budgets per session and account', async () => {
        const count = vi.fn(async () => 10);
        const aggregate = vi.fn(async ({ where }: any) => ({
            _sum: {
                contentBytes: where.sessionId === 'full-session'
                    ? MAX_MESSAGE_BYTES_PER_SESSION
                    : where.session?.accountId === 'full-account'
                        ? MAX_MESSAGE_BYTES_PER_ACCOUNT
                        : 10,
            },
        }));
        const tx = { sessionMessage: { count, aggregate } } as any;

        await expect(getMessageStorageQuotaStatus(tx, 'account-a', 'full-session', 1, 1))
            .resolves.toBe('session-byte-limit');
        await expect(getMessageStorageQuotaStatus(tx, 'full-account', 'session-a', 1, 1))
            .resolves.toBe('account-byte-limit');
        await expect(getMessageStorageQuotaStatus(tx, 'account-a', 'session-a', 1, 1))
            .resolves.toBe('ok');
        await expect(getMessageStorageQuotaStatus(tx, 'full-account', 'full-session', 0, 0))
            .resolves.toBe('ok');

        expect(aggregate).toHaveBeenCalledWith({
            where: { sessionId: 'full-session' },
            _sum: { contentBytes: true },
        });
        expect(aggregate).toHaveBeenCalledWith({
            where: { session: { accountId: 'full-account' } },
            _sum: { contentBytes: true },
        });
    });
});

describe('canAllocateArtifactRows', () => {
    it('caps durable artifacts per account without blocking idempotent restores', async () => {
        const count = vi.fn(async ({ where }: any) => (
            where.accountId === 'full' ? MAX_ARTIFACTS_PER_ACCOUNT : 1
        ));
        const tx = { artifact: { count } } as any;

        await expect(canAllocateArtifactRows(tx, 'full', 1)).resolves.toBe(false);
        await expect(canAllocateArtifactRows(tx, 'full', 0)).resolves.toBe(true);
        await expect(canAllocateArtifactRows(tx, 'other', 1)).resolves.toBe(true);
    });
});
