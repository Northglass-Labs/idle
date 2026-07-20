import { describe, expect, it } from 'vitest';

import {
    FILE_LOAD_LIMITS,
    decodeBase64FileContent,
    exceedsUtf8ByteLimit,
    limitAllSessionFileCaches,
    limitSessionFileCache,
    mapWithConcurrency,
    parseBoundedFilePaths,
    selectBoundedFiles,
} from './fileLoadPolicy';

describe('file loading resource policy', () => {
    it('caps automatic and all-diff file inventories while preserving an explicit target', () => {
        const files = Array.from({ length: 50 }, (_, index) => ({ fullPath: `file-${index}.ts` }));

        expect(selectBoundedFiles(files, FILE_LOAD_LIMITS.prefetch.maxFiles)).toHaveLength(16);
        const allDiff = selectBoundedFiles(files, FILE_LOAD_LIMITS.allDiff.maxFiles, 'file-49.ts');
        expect(allDiff).toHaveLength(32);
        expect(allDiff.at(-1)?.fullPath).toBe('file-49.ts');
    });

    it('limits task count and active concurrency', async () => {
        const started: number[] = [];
        let active = 0;
        let peak = 0;
        const release: Array<() => void> = [];
        const work = mapWithConcurrency(
            Array.from({ length: 10 }, (_, index) => index),
            5,
            2,
            async (item) => {
                started.push(item);
                active += 1;
                peak = Math.max(peak, active);
                await new Promise<void>((resolve) => release.push(resolve));
                active -= 1;
                return item;
            },
        );

        await Promise.resolve();
        expect(started).toEqual([0, 1]);
        while (release.length > 0 || started.length < 5) {
            release.shift()?.();
            await Promise.resolve();
        }

        await expect(work).resolves.toEqual([0, 1, 2, 3, 4]);
        expect(peak).toBe(2);
    });

    it('rejects oversized base64 before decoding and preserves ordinary text', () => {
        const ordinary = Buffer.from('hello\nworld').toString('base64');
        expect(decodeBase64FileContent(ordinary, 32)).toMatchObject({
            text: 'hello\nworld',
            isBinary: false,
            byteLength: 11,
        });

        const oversized = Buffer.alloc(33, 0x61).toString('base64');
        expect(decodeBase64FileContent(oversized, 32)).toBeNull();
    });

    it('counts UTF-8 response bytes without allocating an encoded copy', () => {
        expect(exceedsUtf8ByteLimit(['abc', 'def'], 6)).toBe(false);
        expect(exceedsUtf8ByteLimit(['abc', 'def'], 5)).toBe(true);
        expect(exceedsUtf8ByteLimit(['🙂'], 3)).toBe(true);
        expect(exceedsUtf8ByteLimit(['🙂'], 4)).toBe(false);
    });

    it('bounds file-search paths without materializing an unbounded inventory', () => {
        const output = [
            'src/a.ts',
            'src/b.ts',
            'x'.repeat(20),
            'src/c.ts',
        ].join('\n');

        expect(parseBoundedFilePaths(output, { maxFiles: 2, maxPathLength: 16 })).toEqual([
            'src/a.ts',
            'src/b.ts',
        ]);
    });

    it('evicts old and oversized session-file cache entries', () => {
        const entries = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
            `file-${index}`,
            { content: 'x'.repeat(10), diff: null, isBinary: false, cachedAt: index },
        ]));

        const limited = limitSessionFileCache(entries, { maxEntries: 3, maxApproxBytes: 1_000 });
        expect(Object.keys(limited)).toEqual(['file-4', 'file-3', 'file-2']);

        const oversized = limitSessionFileCache({
            huge: { content: 'x'.repeat(100), diff: null, isBinary: false, cachedAt: 1 },
        }, { maxEntries: 3, maxApproxBytes: 100 });
        expect(oversized).toEqual({});
    });

    it('bounds cache retention across sessions', () => {
        const caches = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
            `session-${index}`,
            {
                file: { content: 'x', diff: null, isBinary: false, cachedAt: index },
            },
        ]));

        const limited = limitAllSessionFileCaches(caches);
        expect(Object.keys(limited)).toHaveLength(FILE_LOAD_LIMITS.cache.maxSessions);
        expect(limited['session-9']).toBeDefined();
        expect(limited['session-0']).toBeUndefined();
    });
});
