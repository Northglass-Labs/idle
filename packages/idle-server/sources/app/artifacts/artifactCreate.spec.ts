import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ARTIFACTS_PER_ACCOUNT } from '../limits/persistedResourceQuotas';

const { state, inTxMock } = vi.hoisted(() => {
    const state = {
        rows: [] as any[],
        countByAccount: new Map<string, number>(),
    };

    const artifact = {
        findUnique: vi.fn(async ({ where }: any) => (
            state.rows.find((row) => row.id === where.id) ?? null
        )),
        count: vi.fn(async ({ where }: any) => (
            state.countByAccount.get(where.accountId)
                ?? state.rows.filter((row) => row.accountId === where.accountId).length
        )),
        create: vi.fn(async ({ data }: any) => {
            if (state.rows.some((row) => row.id === data.id)) {
                throw Object.assign(new Error('duplicate artifact'), { code: 'P2002' });
            }
            const row = {
                ...data,
                headerVersion: 1,
                bodyVersion: 1,
                seq: 0,
                createdAt: new Date(0),
                updatedAt: new Date(0),
            };
            state.rows.push(row);
            return row;
        }),
    };
    const inTxMock = vi.fn(async (fn: (tx: any) => Promise<any>) => fn({ artifact }));
    return { state, inTxMock };
});

vi.mock('../../storage/inTx', () => ({ inTx: inTxMock }));

import { createArtifactWithinQuota } from './artifactCreate';

const input = (id: string) => ({
    id,
    header: new Uint8Array([1]),
    body: new Uint8Array([2]),
    dataEncryptionKey: new Uint8Array([3]),
});

describe('createArtifactWithinQuota', () => {
    beforeEach(() => {
        state.rows.length = 0;
        state.countByAccount.clear();
        vi.clearAllMocks();
    });

    it('refuses a new durable artifact at the account cap', async () => {
        state.countByAccount.set('account-a', MAX_ARTIFACTS_PER_ACCOUNT);

        await expect(createArtifactWithinQuota('account-a', input('artifact-new')))
            .resolves.toEqual({ kind: 'limit' });
        expect(state.rows).toHaveLength(0);
    });

    it('preserves same-account idempotency at the cap and rejects foreign ownership', async () => {
        state.rows.push({
            ...input('artifact-existing'),
            accountId: 'account-a',
            headerVersion: 1,
            bodyVersion: 1,
            seq: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });
        state.rows.push({
            ...input('artifact-foreign'),
            accountId: 'account-b',
            headerVersion: 1,
            bodyVersion: 1,
            seq: 0,
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });
        state.countByAccount.set('account-a', MAX_ARTIFACTS_PER_ACCOUNT);

        const existing = await createArtifactWithinQuota('account-a', input('artifact-existing'));
        expect(existing).toMatchObject({ kind: 'existing', artifact: { id: 'artifact-existing' } });
        await expect(createArtifactWithinQuota('account-a', input('artifact-foreign')))
            .resolves.toEqual({ kind: 'conflict' });
    });

    it('creates below the cap inside the serializable transaction boundary', async () => {
        const result = await createArtifactWithinQuota('account-a', input('artifact-new'));

        expect(result).toMatchObject({ kind: 'created', artifact: { id: 'artifact-new' } });
        expect(inTxMock).toHaveBeenCalledTimes(1);
        expect(state.rows).toHaveLength(1);
    });
});
