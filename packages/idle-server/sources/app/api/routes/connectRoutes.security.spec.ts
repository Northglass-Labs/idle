import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Fastify } from '../types';

const { githubDisconnectMock } = vi.hoisted(() => ({
    githubDisconnectMock: vi.fn(),
}));

vi.mock('../../github/githubDisconnect', () => ({ githubDisconnect: githubDisconnectMock }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { connectRoutes } from './connectRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.removeContentTypeParser('application/json');
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account_123456789';
    });
    connectRoutes(typed);
    await typed.ready();
    return typed;
}

describe('provider credential surface retirement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        { method: 'GET' as const, url: '/v1/connect/github/params' },
        { method: 'GET' as const, url: '/v1/connect/github/callback?code=provider-code&state=provider-state' },
        { method: 'POST' as const, url: '/v1/connect/github/webhook', payload: { action: 'push' } },
        { method: 'POST' as const, url: '/v1/connect/anthropic/register', payload: { token: 'provider-secret' } },
        { method: 'GET' as const, url: '/v1/connect/anthropic/token' },
        { method: 'DELETE' as const, url: '/v1/connect/anthropic' },
        { method: 'GET' as const, url: '/v1/connect/tokens' },
    ])('does not register the retired $method $url route', async ({ method, url, payload }) => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const app = await createApp();

        const response = await app.inject({ method, url, payload });

        expect(response.statusCode).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(githubDisconnectMock).not.toHaveBeenCalled();

        await app.close();
    });
});
