import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startHookServer, type HookServer } from './startHookServer';

const servers: HookServer[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.stop();
    }
});

async function start(onSessionHook = vi.fn()) {
    const server = await startHookServer({ onSessionHook });
    servers.push(server);
    return { server, onSessionHook };
}

function request(server: HookServer, body: string, authorization?: string) {
    return fetch(`http://127.0.0.1:${server.port}/hook/session-start`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
    });
}

describe('startHookServer', () => {
    it('requires the per-process bearer token before mutating the session mapping', async () => {
        const { server, onSessionHook } = await start();
        const body = JSON.stringify({ session_id: 'session-123', source: 'startup' });

        const unauthenticated = await request(server, body);
        expect(unauthenticated.status).toBe(401);
        expect(onSessionHook).not.toHaveBeenCalled();

        const authenticated = await request(server, body, `Bearer ${server.authToken}`);
        expect(authenticated.status).toBe(200);
        expect(onSessionHook).toHaveBeenCalledOnce();
        expect(onSessionHook).toHaveBeenCalledWith(
            'session-123',
            expect.objectContaining({ source: 'startup' }),
        );
    });

    it('rejects oversized bodies before parsing or invoking the hook', async () => {
        const { server, onSessionHook } = await start();
        const oversized = JSON.stringify({
            session_id: 'session-123',
            padding: 'x'.repeat(70 * 1024),
        });

        const response = await request(server, oversized, `Bearer ${server.authToken}`);
        expect(response.status).toBe(413);
        expect(onSessionHook).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON and invalid session identifiers', async () => {
        const { server, onSessionHook } = await start();

        const malformed = await request(server, '{', `Bearer ${server.authToken}`);
        expect(malformed.status).toBe(400);

        const invalidId = await request(
            server,
            JSON.stringify({ session_id: '../unexpected/session' }),
            `Bearer ${server.authToken}`,
        );
        expect(invalidId.status).toBe(400);
        expect(onSessionHook).not.toHaveBeenCalled();
    });

    it('never applies a hook body that finishes after the request timeout', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
            return originalSetTimeout(callback, delay === 5000 ? 10 : delay, ...args);
        }) as typeof setTimeout);
        const { server, onSessionHook } = await start();
        const body = JSON.stringify({ session_id: 'session-after-timeout' });

        try {
            let req!: ReturnType<typeof httpRequest>;
            const status = new Promise<number>((resolve, reject) => {
                req = httpRequest({
                    host: '127.0.0.1',
                    port: server.port,
                    path: '/hook/session-start',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${server.authToken}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                }, (response) => {
                    response.resume();
                    response.once('end', () => resolve(response.statusCode ?? 0));
                });
                req.once('error', reject);
                req.write(body.slice(0, 5));
            });

            await expect(status).resolves.toBe(408);
            req.end(body.slice(5));
            await new Promise((resolve) => originalSetTimeout(resolve, 25));
            expect(onSessionHook).not.toHaveBeenCalled();
        } finally {
            timeoutSpy.mockRestore();
        }
    });
});
