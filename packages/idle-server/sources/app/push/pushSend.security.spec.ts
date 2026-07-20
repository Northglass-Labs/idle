import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendPushNotifications, type PushMessage } from './pushSend';

function message(index = 0): PushMessage {
    return { to: `ExponentPushToken[test-${index}]`, title: 'Idle', body: 'Ready' };
}

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': contentType },
    });
}

describe('Expo push response boundary', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts a bounded ticket response with one ticket per message', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            data: [{ status: 'ok', id: 'ticket-1' }],
        })));

        await expect(sendPushNotifications([message()])).resolves.toEqual([
            { status: 'ok', id: 'ticket-1' },
        ]);
    });

    it('rejects an oversized response without returning provider-controlled fields', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            data: [{ status: 'ok', id: 'ticket-1' }],
            provider_detail: 'x'.repeat(300_000),
        })));

        await expect(sendPushNotifications([message()])).resolves.toEqual([
            { status: 'error', message: 'Network error' },
        ]);
    });

    it('rejects a wrong media type and a non-strict ticket schema', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }, 'text/html'))
            .mockResolvedValueOnce(jsonResponse({
                data: [{ status: 'ok', id: 'ticket-2', provider_secret: 'must-not-cross' }],
            }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(sendPushNotifications([message()])).resolves.toEqual([
            { status: 'error', message: 'Network error' },
        ]);
        await expect(sendPushNotifications([message(1)])).resolves.toEqual([
            { status: 'error', message: 'Network error' },
        ]);
    });

    it('fails the complete batch when the provider returns the wrong ticket count', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            data: [{ status: 'ok', id: 'only-one-ticket' }],
        })));

        await expect(sendPushNotifications([message(0), message(1)])).resolves.toEqual([
            { status: 'error', message: 'Network error' },
            { status: 'error', message: 'Network error' },
        ]);
    });
});
