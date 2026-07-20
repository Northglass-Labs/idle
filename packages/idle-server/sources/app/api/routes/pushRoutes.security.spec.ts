import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const { buildSessionEventEphemeralMock, dbMock, dispatchSessionEventPushMock, eventRouterMock } = vi.hoisted(() => ({
    buildSessionEventEphemeralMock: vi.fn(),
    dbMock: {
        accountPushToken: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            count: vi.fn(),
            deleteMany: vi.fn(),
            findMany: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
        },
        $transaction: vi.fn(),
    },
    dispatchSessionEventPushMock: vi.fn(),
    eventRouterMock: { emitEphemeral: vi.fn() },
}));

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../events/eventRouter', () => ({
    buildSessionEventEphemeral: buildSessionEventEphemeralMock,
    eventRouter: eventRouterMock,
}));
vi.mock('../../push/pushDispatch', () => ({ dispatchSessionEventPush: dispatchSessionEventPushMock }));

import { pushRoutes } from './pushRoutes';

async function createApp(authenticated = false): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        if (!authenticated) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        request.userId = 'account-1';
    });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

describe('push routes authentication boundary', () => {
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = await createApp();
    });
    afterEach(async () => { await app.close(); });

    it.each([
        { method: 'POST', url: '/v1/push-tokens', payload: { token: 'fake-expo-push-token' } },
        { method: 'GET', url: '/v1/push-tokens' },
        { method: 'DELETE', url: '/v1/push-tokens/fake-token' },
    ] as const)('rejects unauthenticated $method $url locally', async ({ method, url, payload }) => {
        const response = await app.inject({ method, url, payload });
        expect(response.statusCode).toBe(401);
        expect(dbMock.accountPushToken.upsert).not.toHaveBeenCalled();
        expect(dbMock.accountPushToken.deleteMany).not.toHaveBeenCalled();
        expect(dbMock.accountPushToken.findMany).not.toHaveBeenCalled();
    });
});

describe('push token account quota', () => {
    const pushTokenLimit = 20;
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        dbMock.accountPushToken.findUnique.mockResolvedValue(null);
        dbMock.accountPushToken.count.mockResolvedValue(0);
        dbMock.accountPushToken.upsert.mockResolvedValue({});
        dbMock.$transaction.mockImplementation(async (callback: (tx: typeof dbMock) => unknown) => callback(dbMock));
        app = await createApp(true);
    });

    afterEach(async () => { await app.close(); });

    it('rejects a new token when the account is at capacity', async () => {
        dbMock.accountPushToken.count.mockResolvedValue(pushTokenLimit);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/push-tokens',
            payload: { token: 'new-device-token' },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Push token limit reached' });
        expect(dbMock.accountPushToken.upsert).not.toHaveBeenCalled();
    });

    it('keeps re-registration idempotent when the account is at capacity', async () => {
        dbMock.accountPushToken.findUnique.mockResolvedValue({ id: 'existing-token-row' });
        dbMock.accountPushToken.count.mockResolvedValue(pushTokenLimit);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/push-tokens',
            payload: { token: 'existing-device-token' },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.accountPushToken.count).not.toHaveBeenCalled();
        expect(dbMock.accountPushToken.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId_token: {
                    accountId: 'account-1',
                    token: 'existing-device-token',
                },
            },
        }));
    });

    it('allows a new device below capacity through a serializable transaction', async () => {
        dbMock.accountPushToken.count.mockResolvedValue(pushTokenLimit - 1);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/push-tokens',
            payload: { token: 'new-device-token' },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.accountPushToken.upsert).toHaveBeenCalledTimes(1);
        expect(dbMock.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable', timeout: 10000 },
        );
    });

    it('bounds the settings list even when legacy rows exceed the cap', async () => {
        const legacyRows = Array.from({ length: pushTokenLimit + 5 }, (_, index) => ({
            id: `row-${index}`,
            token: `device-token-${index}`,
            createdAt: new Date(1_000 + index),
            updatedAt: new Date(2_000 + index),
        }));
        dbMock.accountPushToken.findMany.mockResolvedValue(legacyRows);

        const response = await app.inject({ method: 'GET', url: '/v1/push-tokens' });

        expect(response.statusCode).toBe(200);
        expect(response.json().tokens).toHaveLength(pushTokenLimit);
        expect(dbMock.accountPushToken.findMany).toHaveBeenCalledWith({
            where: { accountId: 'account-1' },
            orderBy: { updatedAt: 'desc' },
            take: pushTokenLimit,
        });
    });
});

describe('push event privacy boundary', () => {
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        dbMock.session.findFirst.mockResolvedValue({ id: 'session-1' });
        buildSessionEventEphemeralMock.mockReturnValue({ type: 'session-event' });
        app = await createApp(true);
    });

    afterEach(async () => { await app.close(); });

    it('replaces client-provided notification text and data with generic server-owned copy', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/session-1/push-event',
            payload: {
                kind: 'permission',
                title: 'Secret customer name',
                body: 'Private repository and transcript summary',
                data: {
                    provider: 'private-provider',
                    sessionTitle: 'Secret customer name',
                    url: 'https://tracker.example/unique',
                },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(buildSessionEventEphemeralMock).toHaveBeenCalledWith(
            'session-1',
            'permission',
            'Permission request',
            'Open Idle to review this session.',
        );
        expect(dispatchSessionEventPushMock).toHaveBeenCalledWith({
            userId: 'account-1',
            sessionId: 'session-1',
            title: 'Permission request',
            body: 'Open Idle to review this session.',
            data: { kind: 'permission' },
        });
        expect(JSON.stringify(dispatchSessionEventPushMock.mock.calls)).not.toMatch(/Secret|Private|tracker|provider/);
    });
});
