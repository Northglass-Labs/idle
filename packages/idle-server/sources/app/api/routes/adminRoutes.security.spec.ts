import fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '../types';

const { accountDeleteMock, authMock, dbMock, eventRouterMock } = vi.hoisted(() => ({
    accountDeleteMock: vi.fn(),
    authMock: {
        adminStats: vi.fn(() => ({ tokenCacheSize: 2, revokedCount: 1 })),
        suspendUser: vi.fn(async () => ({ found: true, invalidatedTokens: 2 })),
        resumeUser: vi.fn(async () => true),
    },
    dbMock: {
        account: {
            findMany: vi.fn(),
        },
        machine: {
            findMany: vi.fn(),
        },
    },
    eventRouterMock: {
        disconnectUserConnections: vi.fn(),
    },
}));

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../auth/auth', () => ({ auth: authMock }));
vi.mock('../../account/accountDelete', () => ({ accountDelete: accountDeleteMock }));
vi.mock('../../events/eventRouter', () => ({ eventRouter: eventRouterMock }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { adminRoutes } from './adminRoutes';

const ADMIN_SECRET = 'a1'.repeat(32);

async function createApp(withRateLimit = false): Promise<Fastify> {
    const app = fastify();
    if (withRateLimit) {
        await app.register(fastifyRateLimit, {
            max: 100,
            timeWindow: '1 minute',
        });
    }
    const typed = app as unknown as Fastify;
    adminRoutes(typed);
    await typed.ready();
    return typed;
}

describe('admin account suspension security', () => {
    let app: Fastify;

    beforeEach(async () => {
        process.env.IDLE_ADMIN_SECRET = ADMIN_SECRET;
        vi.clearAllMocks();
        authMock.adminStats.mockReturnValue({ tokenCacheSize: 2, revokedCount: 1 });
        authMock.suspendUser.mockResolvedValue({ found: true, invalidatedTokens: 2 });
        authMock.resumeUser.mockResolvedValue(true);
        dbMock.account.findMany.mockResolvedValue([]);
        dbMock.machine.findMany.mockResolvedValue([]);
        app = await createApp();
    });

    afterEach(async () => {
        delete process.env.IDLE_ADMIN_SECRET;
        await app.close();
    });

    it('durably suspends the account before disconnecting its live connections', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/admin/accounts/account-1/revoke',
            headers: { 'x-admin-secret': ADMIN_SECRET },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            userId: 'account-1',
            status: 'suspended',
            revokedTokens: 2,
        });
        expect(authMock.suspendUser).toHaveBeenCalledWith('account-1');
        expect(eventRouterMock.disconnectUserConnections).toHaveBeenCalledWith('account-1');
        expect(authMock.suspendUser.mock.invocationCallOrder[0])
            .toBeLessThan(eventRouterMock.disconnectUserConnections.mock.invocationCallOrder[0]);
    });

    it('does not disconnect or claim success when the account does not exist', async () => {
        authMock.suspendUser.mockResolvedValueOnce({ found: false, invalidatedTokens: 0 });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/admin/accounts/missing-account/revoke',
            headers: { 'x-admin-secret': ADMIN_SECRET },
        });

        expect(response.statusCode).toBe(404);
        expect(eventRouterMock.disconnectUserConnections).not.toHaveBeenCalled();
    });

    it('requires the operator-only endpoint to resume a suspended account', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/admin/accounts/account-1/enable',
            headers: { 'x-admin-secret': ADMIN_SECRET },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ userId: 'account-1', status: 'enabled' });
        expect(authMock.resumeUser).toHaveBeenCalledWith('account-1');
    });

    it('does not allow an account bearer or missing admin secret to enable authentication', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/admin/accounts/account-1/enable',
            headers: { authorization: 'Bearer account-token' },
        });

        expect(response.statusCode).toBe(401);
        expect(authMock.resumeUser).not.toHaveBeenCalled();
    });

    it('exposes durable suspension status in the bounded admin account list', async () => {
        const suspendedAt = new Date('2026-07-13T03:00:00.000Z');
        dbMock.account.findMany.mockResolvedValueOnce([
            {
                id: 'suspended-account',
                firstName: null,
                lastName: null,
                username: null,
                createdAt: new Date('2026-07-01T00:00:00.000Z'),
                githubUser: null,
                authSuspendedAt: suspendedAt,
            },
            {
                id: 'enabled-account',
                firstName: null,
                lastName: null,
                username: null,
                createdAt: new Date('2026-07-02T00:00:00.000Z'),
                githubUser: null,
                authSuspendedAt: null,
            },
        ]);

        const response = await app.inject({
            method: 'GET',
            url: '/v1/admin/accounts',
            headers: { 'x-admin-secret': ADMIN_SECRET },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            total: 2,
            suspended: 1,
            accounts: [
                { id: 'suspended-account', status: 'suspended', suspendedAt: suspendedAt.toISOString() },
                { id: 'enabled-account', status: 'enabled', suspendedAt: null },
            ],
        });
        expect(dbMock.account.findMany).toHaveBeenCalledWith(expect.objectContaining({
            take: 500,
            select: expect.objectContaining({ authSuspendedAt: true }),
        }));
    });

    it('renders explicit Suspend and Enable controls in the operator panel', async () => {
        const response = await app.inject({ method: 'GET', url: '/admin' });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('Suspended');
        expect(response.body).toContain("'/enable'");
        expect(response.body).toContain('Suspend account');
        expect(response.body).toContain('Enable account');
    });

    it('stream-limits every admin panel JSON response before parsing it', async () => {
        const response = await app.inject({ method: 'GET', url: '/admin' });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('MAX_ADMIN_JSON_BYTES');
        expect(response.body).toContain('response.body.getReader()');
        expect(response.body).toContain('Admin response exceeded the byte limit');
        expect(response.body).not.toContain('.json()');
    });

    it('disables every data route unless the admin secret is a random 32-byte hex value', async () => {
        for (const configured of [undefined, 'short-secret', 'g'.repeat(64), 'a'.repeat(63)]) {
            if (configured === undefined) delete process.env.IDLE_ADMIN_SECRET;
            else process.env.IDLE_ADMIN_SECRET = configured;

            const response = await app.inject({
                method: 'GET',
                url: '/v1/admin/accounts',
                headers: { 'x-admin-secret': configured ?? ADMIN_SECRET },
            });

            expect(response.statusCode).toBe(503);
            expect(dbMock.account.findMany).not.toHaveBeenCalled();
        }
    });

    it('marks the panel and every admin API response as non-cacheable', async () => {
        const requests = [
            { method: 'GET' as const, url: '/admin' },
            { method: 'GET' as const, url: '/v1/admin/unknown' },
            { method: 'GET' as const, url: '/v1/admin/accounts', headers: { 'x-admin-secret': ADMIN_SECRET } },
            { method: 'GET' as const, url: '/v1/admin/accounts' },
            { method: 'POST' as const, url: '/v1/admin/accounts/account-1/revoke', headers: { 'x-admin-secret': ADMIN_SECRET } },
            { method: 'POST' as const, url: '/v1/admin/accounts/account-1/enable', headers: { 'x-admin-secret': ADMIN_SECRET } },
            { method: 'POST' as const, url: '/v1/admin/cleanup-stale', headers: { 'x-admin-secret': ADMIN_SECRET } },
        ];

        for (const request of requests) {
            const response = await app.inject(request);
            expect(response.headers['cache-control'], `${request.method} ${request.url}`).toBe('no-store');
        }
    });

    it('uses a hash-authorized panel script and keeps the admin secret in memory only', async () => {
        const response = await app.inject({ method: 'GET', url: '/admin' });
        const csp = response.headers['content-security-policy'];

        expect(csp).toMatch(/^default-src 'none';/);
        expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
        expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain('unsafe-inline');
        expect(csp).not.toContain('unsafe-eval');
        expect(response.body).not.toMatch(/\bonclick\s*=/i);
        expect(response.body).not.toMatch(/\bstyle\s*=/i);
        expect(response.body).not.toMatch(/sessionStorage|localStorage|indexedDB/i);
        expect(response.body).toContain("let adminSecret=''");
    });

    it('rate-limits repeated admin-secret guesses at the route boundary', async () => {
        const throttled = await createApp(true);
        try {
            const statuses: number[] = [];
            const cacheControls: Array<string | string[] | undefined> = [];
            for (let attempt = 0; attempt < 6; attempt += 1) {
                const response = await throttled.inject({
                    method: 'GET',
                    url: '/v1/admin/accounts',
                    headers: { 'x-admin-secret': `b${attempt}`.padEnd(64, '0') },
                });
                statuses.push(response.statusCode);
                cacheControls.push(response.headers['cache-control']);
            }

            expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
            expect(statuses[5]).toBe(429);
            expect(cacheControls).toEqual(Array(6).fill('no-store'));
        } finally {
            await throttled.close();
        }
    });
});
