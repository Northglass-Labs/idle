import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    tx,
    callbacks,
    allocateUserSeqMock,
    buildKVBatchUpdateMock,
    emitUpdateMock,
    transactionState,
} = vi.hoisted(() => ({
    callbacks: [] as Array<() => void | Promise<void>>,
    allocateUserSeqMock: vi.fn(async () => 7),
    buildKVBatchUpdateMock: vi.fn(() => ({ body: { t: 'kv-batch-update' } })),
    emitUpdateMock: vi.fn(),
    transactionState: { allocationsBeforeCallbacks: 0, payloadsBeforeCallbacks: 0 },
    tx: {
        userKVStore: {
            findUnique: vi.fn(async () => null),
            create: vi.fn(async () => ({ version: 0 })),
            update: vi.fn(),
        },
    },
}));

vi.mock('../../storage/db', () => ({ db: {} }));
vi.mock('../../storage/inTx', () => ({
    inTx: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        transactionState.allocationsBeforeCallbacks = allocateUserSeqMock.mock.calls.length;
        transactionState.payloadsBeforeCallbacks = buildKVBatchUpdateMock.mock.calls.length;
        for (const callback of callbacks.splice(0)) await callback();
        return result;
    }),
    afterTx: vi.fn((_tx: unknown, callback: () => void | Promise<void>) => callbacks.push(callback)),
}));
vi.mock('../../storage/seq', () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock('../events/eventRouter', () => ({
    eventRouter: { emitUpdate: emitUpdateMock },
    buildKVBatchUpdateUpdate: buildKVBatchUpdateMock,
}));
vi.mock('../limits/persistedResourceQuotas', () => ({
    canAllocateKVRows: vi.fn(async () => true),
}));
vi.mock('../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));

import { kvMutate } from './kvMutate';

describe('kvMutate transactional update notification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callbacks.splice(0);
        transactionState.allocationsBeforeCallbacks = 0;
        transactionState.payloadsBeforeCallbacks = 0;
    });

    it('allocates its sequence and builds its payload before the transaction commits', async () => {
        await expect(kvMutate({ uid: 'account-1' }, [{
            key: 'key-1',
            value: Buffer.from('value').toString('base64'),
            version: -1,
        }])).resolves.toEqual({
            success: true,
            results: [{ key: 'key-1', version: 0 }],
        });

        expect(transactionState.allocationsBeforeCallbacks).toBe(1);
        expect(transactionState.payloadsBeforeCallbacks).toBe(1);
        expect(allocateUserSeqMock).toHaveBeenCalledWith('account-1', tx);
        expect(emitUpdateMock).toHaveBeenCalledOnce();
    });
});
