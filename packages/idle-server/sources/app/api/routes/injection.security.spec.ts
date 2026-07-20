import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const { authMock, dbMock } = vi.hoisted(() => {
    const pairingModel = {
        upsert: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
    };
    return {
        authMock: { createToken: vi.fn() },
        dbMock: {
            repeatKey: { create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
            account: { upsert: vi.fn() },
            terminalAuthRequest: pairingModel,
            accountAuthRequest: { ...pairingModel },
        },
    };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../auth/auth', () => ({ auth: authMock }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { authRoutes } from './authRoutes';

const TEST_CHALLENGE_ID = '123e4567-e89b-12d3-a456-426614174000';
const SQL_PAYLOADS = [
    "'; DROP TABLE sessions; --",
    "1' OR '1'='1",
    '1; SELECT * FROM accounts--',
    "' UNION SELECT token FROM accounts--",
    "'; UPDATE accounts SET publicKey='pwned' WHERE '1'='1",
    '1\'; TRUNCATE TABLE "TerminalAuthRequest"--',
    "' OR 1=1; --",
];
const NOSQL_PAYLOADS = [
    '{"$gt": ""}',
    '{"$ne": null}',
    '{"$where": "sleep(5000)"}',
    '{"$regex": ".*"}',
];
const HEADER_INJECTION_PAYLOADS = [
    'value\r\nX-Injected: true',
    'value\nSet-Cookie: evil=1',
    'value%0d%0aInjected-Header: yes',
];
const TEMPLATE_INJECTION_PAYLOADS = ['{{7*7}}', '${7*7}', '<%= 7*7 %>', '#{7*7}'];

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (_request: unknown, reply: any) => {
        return reply.code(401).send({ error: 'Unauthorized' });
    });
    authRoutes(typed);
    await typed.ready();
    return typed;
}

async function expectClientRejection(app: Fastify, options: Parameters<Fastify['inject']>[0]): Promise<void> {
    const response = await app.inject(options);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
}

describe('auth-route injection prevention through local Fastify', () => {
    let app: Fastify;

    beforeAll(async () => {
        process.env.IDLE_AUTH_AUDIENCE = 'https://relay.test';
        app = await createApp();
    });
    afterAll(async () => {
        delete process.env.IDLE_AUTH_AUDIENCE;
        await app.close();
    });

    for (const payload of SQL_PAYLOADS) {
        it(`rejects SQL syntax in public keys: ${payload.slice(0, 32)}`, async () => {
            await expectClientRejection(app, {
                method: 'POST',
                url: '/v1/auth',
                payload: { version: 3, publicKey: payload, challengeId: TEST_CHALLENGE_ID, signature: 'dGVzdA==' },
            });
            await expectClientRejection(app, {
                method: 'POST',
                url: '/v1/auth/request',
                payload: { publicKey: payload },
            });
            await expectClientRejection(app, {
                method: 'GET',
                url: `/v1/auth/request/status?publicKey=${encodeURIComponent(payload)}`,
            });
            await expectClientRejection(app, {
                method: 'POST',
                url: '/v1/auth/account/request',
                payload: { publicKey: payload },
            });
        });

        it(`rejects SQL syntax in challengeId: ${payload.slice(0, 32)}`, async () => {
            await expectClientRejection(app, {
                method: 'POST',
                url: '/v1/auth',
                payload: { version: 3, publicKey: 'dGVzdA==', challengeId: payload, signature: 'dGVzdA==' },
            });
        });
    }

    it.each(NOSQL_PAYLOADS)('rejects object-shaped text in a public key: %s', async (payload) => {
        await expectClientRejection(app, {
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey: payload, challengeId: TEST_CHALLENGE_ID, signature: 'dGVzdA==' },
        });
    });

    it.each(HEADER_INJECTION_PAYLOADS)('rejects header injection text in a public key: %s', async (payload) => {
        await expectClientRejection(app, {
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey: payload, challengeId: TEST_CHALLENGE_ID, signature: 'dGVzdA==' },
        });
    });

    it.each(TEMPLATE_INJECTION_PAYLOADS)('rejects template syntax in a public key: %s', async (payload) => {
        await expectClientRejection(app, {
            method: 'POST',
            url: '/v1/auth/request',
            payload: { publicKey: payload },
        });
    });

    it.each([
        { method: 'POST', url: '/v1/auth', payload: { version: 3, publicKey: 'a'.repeat(100_000), challengeId: TEST_CHALLENGE_ID, signature: 'dGVzdA==' } },
        { method: 'POST', url: '/v1/auth/request', payload: { publicKey: 'a'.repeat(100_000) } },
        { method: 'POST', url: '/v1/auth/account/request', payload: { publicKey: 'a'.repeat(100_000) } },
        { method: 'GET', url: `/v1/auth/request/status?publicKey=${'a'.repeat(100_000)}` },
    ] as const)('rejects oversized input for $method $url', async (options) => {
        await expectClientRejection(app, options);
    });

    it.each([
        12345,
        true,
        ['a', 'b'],
        { publicKey: 'nested' },
        null,
    ])('rejects a non-string public key: %j', async (publicKey) => {
        await expectClientRejection(app, {
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey, challengeId: TEST_CHALLENGE_ID, signature: 'dGVzdA==' },
        });
    });

    it.each([
        { method: 'POST', url: '/v1/auth', payload: {} },
        { method: 'POST', url: '/v1/auth', payload: { publicKey: 'dGVzdA==' } },
        { method: 'POST', url: '/v1/auth/request', payload: {} },
        { method: 'GET', url: '/v1/auth/request/status' },
    ] as const)('rejects missing required fields for $method $url', async (options) => {
        await expectClientRejection(app, options);
    });
});
