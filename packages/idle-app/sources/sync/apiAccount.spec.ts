import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteAccount } from './apiAccount';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.example.test' }));

afterEach(() => vi.unstubAllGlobals());

describe('account deletion HTTP contract', () => {
    it('sends a parseable JSON request to the authenticated deletion endpoint', async () => {
        const requests: Request[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            const request = new Request(url, init);
            requests.push(request);
            // The relay parses application/json before entering its route.
            // A JSON content type with an empty body fails that boundary.
            await request.json();
            return Response.json({ success: true });
        }));

        await expect(deleteAccount({ token: 'test-token', secret: 'test-secret' })).resolves.toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe('https://relay.example.test/v1/account/delete');
        expect(requests[0].method).toBe('POST');
        expect(requests[0].headers.get('authorization')).toBe('Bearer test-token');
    });

    it('rejects an unsuccessful deletion without exposing the response body', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('private server detail', { status: 503 })));
        await expect(deleteAccount({ token: 'test-token', secret: 'test-secret' }))
            .rejects.toThrow('Failed to delete account: 503');
    });
});
