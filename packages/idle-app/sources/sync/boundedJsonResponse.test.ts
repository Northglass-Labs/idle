import { describe, expect, it, vi } from 'vitest';

import {
    readBoundedJsonResponse,
    readBoundedResponseBytes,
    readBoundedTextResponse,
} from './boundedJsonResponse';

describe('bounded JSON response consumption', () => {
    it('parses an ordinary response inside the byte ceiling', async () => {
        const response = new Response(JSON.stringify({ messages: [], hasMore: false }));
        await expect(readBoundedJsonResponse(response, 1024)).resolves.toEqual({ messages: [], hasMore: false });
    });

    it('rejects an oversized declared body before reading it', async () => {
        const text = vi.fn();
        const response = {
            headers: new Headers({ 'content-length': '1025' }),
            body: null,
            text,
        } as unknown as Response;

        await expect(readBoundedJsonResponse(response, 1024)).rejects.toThrow('response limit');
        expect(text).not.toHaveBeenCalled();
    });

    it('stops a streaming body once actual bytes exceed the ceiling', async () => {
        let cancelled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"value":"'));
                controller.enqueue(new Uint8Array(1024));
            },
            cancel() {
                cancelled = true;
            },
        }));

        await expect(readBoundedJsonResponse(response, 64)).rejects.toThrow('response limit');
        expect(cancelled).toBe(true);
    });

    it('fails closed without a readable byte stream instead of allocating response text', async () => {
        const text = vi.fn(async () => JSON.stringify({ messages: [] }));
        const response = {
            headers: new Headers(),
            body: null,
            text,
        } as unknown as Response;

        await expect(readBoundedJsonResponse(response, 1024)).rejects.toThrow(
            'readable byte stream',
        );
        expect(text).not.toHaveBeenCalled();
    });

    it('returns bounded binary bodies without calling arrayBuffer', async () => {
        const arrayBuffer = vi.fn();
        const response = new Response(new Uint8Array([1, 2, 3, 4]));
        Object.defineProperty(response, 'arrayBuffer', { value: arrayBuffer });

        await expect(readBoundedResponseBytes(response, 4)).resolves.toEqual(
            new Uint8Array([1, 2, 3, 4]),
        );
        expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('decodes bounded error text and rejects an oversized stream', async () => {
        await expect(readBoundedTextResponse(new Response('safe error'), 32))
            .resolves.toBe('safe error');
        await expect(readBoundedTextResponse(new Response('x'.repeat(33)), 32))
            .rejects.toThrow('response limit');
    });
});
