import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readBoundedJsonResponse, readBoundedResponseBytes } from './boundedResponse';

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = chunks.shift();
            if (chunk) {
                controller.enqueue(chunk);
                return;
            }
            controller.close();
        },
    }), { headers });
}

describe('bounded upstream response readers', () => {
    it('enforces the streamed byte limit even when Content-Length lies', async () => {
        const response = streamedResponse(
            [new Uint8Array(4), new Uint8Array(5)],
            { 'content-length': '1', 'content-type': 'image/png' },
        );

        await expect(readBoundedResponseBytes(response, {
            maxBytes: 8,
            allowedContentTypes: ['image/png'],
        })).rejects.toThrow('Upstream response exceeded the byte limit');
    });

    it('rejects an oversized declared length before reading the body', async () => {
        let pulled = false;
        const response = new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled = true;
                controller.enqueue(new Uint8Array(1));
                controller.close();
            },
        }, { highWaterMark: 0 }), { headers: { 'content-length': '9', 'content-type': 'image/png' } });

        await expect(readBoundedResponseBytes(response, {
            maxBytes: 8,
            allowedContentTypes: ['image/png'],
        })).rejects.toThrow('Upstream response exceeded the byte limit');
        expect(pulled).toBe(false);
    });

    it('validates media type before reading the body', async () => {
        const response = streamedResponse(
            [new TextEncoder().encode('<html>not an image</html>')],
            { 'content-type': 'text/html' },
        );

        await expect(readBoundedResponseBytes(response, {
            maxBytes: 1024,
            allowedContentTypes: ['image/png', 'image/jpeg'],
        })).rejects.toThrow('Unexpected upstream response content type');
    });

    it('accepts bounded JSON only when it matches a strict schema', async () => {
        const schema = z.object({ ok: z.literal(true) }).strict();
        const valid = new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
        const extra = new Response(JSON.stringify({ ok: true, secret: 'provider-detail' }), {
            headers: { 'content-type': 'application/json' },
        });

        await expect(readBoundedJsonResponse(valid, 128, schema)).resolves.toEqual({ ok: true });
        await expect(readBoundedJsonResponse(extra, 128, schema))
            .rejects.toThrow('Invalid upstream JSON response');
    });

    it('rejects malformed, non-JSON, and oversized JSON bodies with fixed errors', async () => {
        const schema = z.object({ ok: z.literal(true) }).strict();
        const malformed = new Response('{"ok":', {
            headers: { 'content-type': 'application/json' },
        });
        const wrongType = new Response('{"ok":true}', {
            headers: { 'content-type': 'text/plain' },
        });
        const oversized = streamedResponse(
            [new TextEncoder().encode('{"ok":true,"padding":"xxxxxxxx"}')],
            { 'content-length': '2', 'content-type': 'application/json' },
        );

        await expect(readBoundedJsonResponse(malformed, 128, schema))
            .rejects.toThrow('Invalid upstream JSON response');
        await expect(readBoundedJsonResponse(wrongType, 128, schema))
            .rejects.toThrow('Unexpected upstream response content type');
        await expect(readBoundedJsonResponse(oversized, 16, schema))
            .rejects.toThrow('Upstream response exceeded the byte limit');
    });
});
