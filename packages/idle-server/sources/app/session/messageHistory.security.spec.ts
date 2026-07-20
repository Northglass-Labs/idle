import { describe, expect, it, vi } from 'vitest';

import {
    HistoryResponseLimitError,
    readBoundedMessageHistory,
    serializeBoundedMessageHistory,
} from './messageHistory';

function row(id: string, seq: number, ciphertext: string) {
    return {
        id,
        seq,
        localId: `local-${id}`,
        content: { t: 'encrypted', c: ciphertext },
        contentBytes: Buffer.byteLength(ciphertext, 'utf8'),
        createdAt: new Date(seq * 1_000),
        updatedAt: new Date(seq * 1_000),
    };
}

describe('bounded message history materialization', () => {
    it('selects metadata first and fetches content only for the byte-bounded prefix', async () => {
        const rows = [row('one', 1, '123456'), row('two', 2, 'abcdef'), row('three', 3, 'last')];
        const findMany = vi.fn(async (args: any) => {
            if (args.select.content) {
                const ids = new Set(args.where.id.in);
                return rows.filter((candidate) => ids.has(candidate.id)).map((candidate) => ({
                    id: candidate.id,
                    content: candidate.content,
                    contentBytes: candidate.contentBytes,
                }));
            }
            return rows.map(({ content: _content, ...metadata }) => metadata);
        });

        const page = await readBoundedMessageHistory(
            { sessionMessage: { findMany } },
            {
                where: { sessionId: 'session-1' },
                orderBy: { seq: 'asc' },
                limit: 3,
                mode: 'paginated',
                contentByteLimit: 10,
            },
        );

        expect(page.messages.map((message) => message.id)).toEqual(['one']);
        expect(page.hasMore).toBe(true);
        expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            take: 4,
            select: expect.objectContaining({ contentBytes: true }),
        }));
        expect(findMany.mock.calls[0][0].select).not.toHaveProperty('content');
        expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({ id: { in: ['one'] } }),
            select: { id: true, content: true, contentBytes: true },
        }));
    });

    it('fails closed before selecting content when a legacy response would be truncated', async () => {
        const rows = [row('one', 1, '123456'), row('two', 2, 'abcdef')];
        const findMany = vi.fn(async () => rows.map(({ content: _content, ...metadata }) => metadata));

        await expect(readBoundedMessageHistory(
            { sessionMessage: { findMany } },
            {
                where: { sessionId: 'session-1' },
                orderBy: { seq: 'desc' },
                limit: 2,
                mode: 'legacy',
                contentByteLimit: 10,
            },
        )).rejects.toBeInstanceOf(HistoryResponseLimitError);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0][0].select).not.toHaveProperty('content');
    });

    it('rejects stored size drift instead of sending an under-accounted ciphertext', async () => {
        const stored = row('one', 1, 'ciphertext');
        const findMany = vi.fn()
            .mockResolvedValueOnce([{ ...stored, content: undefined }])
            .mockResolvedValueOnce([{
                id: stored.id,
                content: stored.content,
                contentBytes: stored.contentBytes - 1,
            }]);

        await expect(readBoundedMessageHistory(
            { sessionMessage: { findMany } },
            {
                where: { sessionId: 'session-1' },
                orderBy: { seq: 'asc' },
                limit: 1,
                mode: 'paginated',
            },
        )).rejects.toBeInstanceOf(HistoryResponseLimitError);
    });

    it('enforces the final serialized response ceiling', () => {
        expect(() => serializeBoundedMessageHistory({ messages: ['x'.repeat(100)] }, 32))
            .toThrow(HistoryResponseLimitError);
        expect(serializeBoundedMessageHistory({ messages: [] }, 32)).toBe('{"messages":[]}');
    });
});
