import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('../../storage/db', () => ({
    db: { userKVStore: { findMany } },
}));

import {
    MAX_KV_LIST_ITEMS,
    MAX_KV_LIST_RESPONSE_CHARS,
    kvList,
} from './kvList';

describe('KV list aggregate response boundary', () => {
    beforeEach(() => findMany.mockReset());

    it('clamps database materialization and encoded output to aggregate budgets', async () => {
        findMany.mockResolvedValue(Array.from({ length: MAX_KV_LIST_ITEMS }, (_, index) => ({
            key: `key-${index}`,
            value: Buffer.alloc(64 * 1024, index),
            version: 1,
        })));

        const result = await kvList({ uid: 'account-1' }, { limit: 1_000 });
        const responseChars = result.items.reduce(
            (total, item) => total + item.key.length + item.value.length + 32,
            0,
        );

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: MAX_KV_LIST_ITEMS }));
        expect(result.items.length).toBeLessThan(MAX_KV_LIST_ITEMS);
        expect(responseChars).toBeLessThanOrEqual(MAX_KV_LIST_RESPONSE_CHARS);
        expect(result.truncated).toBe(true);
    });
});
