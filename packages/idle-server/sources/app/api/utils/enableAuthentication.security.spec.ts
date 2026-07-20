import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_REGISTRATION_CREDENTIAL_PURPOSE } from '../../auth/credentialPurpose';

const { authMock } = vi.hoisted(() => ({
    authMock: { verifyToken: vi.fn() },
}));

vi.mock('../../auth/auth', () => ({ auth: authMock }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { enableAuthentication } from './enableAuthentication';

describe('HTTP bearer purpose boundary', () => {
    const apps: ReturnType<typeof fastify>[] = [];

    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
        authMock.verifyToken.mockReset();
    });

    async function createProtectedApp() {
        const app = fastify();
        apps.push(app);
        enableAuthentication(app as any);
        app.get('/protected', { preHandler: (app as any).authenticate }, async (request: any) => ({
            userId: request.userId,
        }));
        await app.ready();
        return app;
    }

    it('accepts an ordinary bearer', async () => {
        authMock.verifyToken.mockResolvedValueOnce({ userId: 'account-1' });
        const app = await createProtectedApp();

        const response = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: 'Bearer ordinary-token' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ userId: 'account-1' });
    });

    it('rejects a dedicated RPC registration credential', async () => {
        authMock.verifyToken.mockResolvedValueOnce({
            userId: 'account-1',
            extras: { credentialPurpose: RPC_REGISTRATION_CREDENTIAL_PURPOSE },
        });
        const app = await createProtectedApp();

        const response = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: { authorization: 'Bearer rpc-registration-token' },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid token' });
    });
});
