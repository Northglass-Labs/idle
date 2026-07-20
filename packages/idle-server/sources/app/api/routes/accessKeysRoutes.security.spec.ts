import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        session: { findFirst: vi.fn() },
        machine: { findFirst: vi.fn() },
        accessKey: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
        },
    },
}));

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { accessKeysRoutes } from './accessKeysRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (_request: unknown, reply: any) => {
        return reply.code(401).send({ error: 'Unauthorized' });
    });
    accessKeysRoutes(typed);
    await typed.ready();
    return typed;
}

describe('access-key routes authentication boundary', () => {
    let app: Fastify;

    beforeEach(async () => { app = await createApp(); });
    afterEach(async () => { await app.close(); });

    it.each([
        { method: 'GET', url: '/v1/access-keys/session-1/machine-1' },
        { method: 'POST', url: '/v1/access-keys/session-1/machine-1', payload: { data: 'encrypted-data' } },
        { method: 'PUT', url: '/v1/access-keys/session-1/machine-1', payload: { data: 'encrypted-data', expectedVersion: 1 } },
    ] as const)('rejects unauthenticated $method $url locally', async ({ method, url, payload }) => {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(401);
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
        expect(dbMock.machine.findFirst).not.toHaveBeenCalled();
        expect(dbMock.accessKey.findUnique).not.toHaveBeenCalled();
    });
});
