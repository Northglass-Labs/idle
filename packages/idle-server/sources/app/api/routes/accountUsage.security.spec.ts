import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '../types';

const EXPECTED_MAX_USAGE_REPORTS = 1_000;

const { dbMock, logMock } = vi.hoisted(() => ({
    dbMock: {
        account: {
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            updateMany: vi.fn(),
        },
        session: { findFirst: vi.fn(async () => ({ id: 'session-a' })) },
        usageReport: { findMany: vi.fn(async () => []) },
    },
    logMock: vi.fn(),
}));

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../events/eventRouter', () => ({
    buildUpdateAccountUpdate: vi.fn(),
    eventRouter: { emitUpdate: vi.fn() },
}));
vi.mock('../../../storage/files', () => ({ getPublicUrl: vi.fn() }));
vi.mock('../../../storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn() }));
vi.mock('../../../utils/log', () => ({ log: logMock }));
vi.mock('../../account/accountDelete', () => ({ accountDelete: vi.fn() }));

import { accountRoutes } from './accountRoutes';

const validData = {
    tokens: {
        total: 15,
        input: 5,
        output: 4,
        cache_creation: 3,
        cache_read: 3,
    },
    cost: {
        total: 0.15,
        input: 0.05,
        output: 0.10,
    },
};

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'account-a';
    });
    accountRoutes(typed);
    await typed.ready();
    return typed;
}

describe('usage query security boundary', () => {
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        dbMock.session.findFirst.mockResolvedValue({ id: 'session-a' });
        dbMock.usageReport.findMany.mockResolvedValue([]);
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it.each([
        [{ startTime: 200, endTime: 100 }, 'inverted range'],
        [{ startTime: Number.MAX_SAFE_INTEGER }, 'out-of-range timestamp'],
        [{ groupBy: 'week' }, 'unknown grouping'],
        [{ unexpected: true }, 'unexpected input field'],
    ])('rejects %s (%s) before querying', async (payload) => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload,
        });

        expect(response.statusCode).toBe(400);
        expect(dbMock.usageReport.findMany).not.toHaveBeenCalled();
    });

    it('caps database materialization at one row beyond the session quota', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.usageReport.findMany).toHaveBeenCalledWith(expect.objectContaining({
            take: EXPECTED_MAX_USAGE_REPORTS + 1,
            select: { createdAt: true, data: true },
        }));
    });

    it('fails closed on a legacy overflow without aggregating an unbounded result', async () => {
        dbMock.usageReport.findMany.mockResolvedValue(Array.from(
            { length: EXPECTED_MAX_USAGE_REPORTS + 1 },
            (_, index) => ({
                createdAt: new Date(1_700_000_000_000 + index),
                data: validData,
            }),
        ));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload: {},
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: 'Usage query exceeds retained report limit' });
    });

    it('drops malformed legacy JSON and emits only fixed known fields', async () => {
        dbMock.usageReport.findMany.mockResolvedValue([
            {
                createdAt: new Date('2026-07-13T12:30:00.000Z'),
                data: validData,
            },
            {
                createdAt: new Date('2026-07-13T12:31:00.000Z'),
                data: {
                    tokens: { ...validData.tokens, attacker_dimension: 999 },
                    cost: validData.cost,
                },
            },
            {
                createdAt: new Date('2026-07-13T12:32:00.000Z'),
                data: {
                    tokens: { total: Number.MAX_SAFE_INTEGER },
                    cost: { total: 0 },
                },
            },
        ]);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload: { groupBy: 'hour' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            usage: [{
                timestamp: 1_783_944_000,
                tokens: validData.tokens,
                cost: validData.cost,
                reportCount: 1,
            }],
            groupBy: 'hour',
            totalReports: 1,
        });
        expect(Object.keys(response.json().usage[0].tokens)).toHaveLength(5);
        expect(Object.keys(response.json().usage[0].cost)).toHaveLength(3);
    });

    it('preserves an owned-session query and canonical UI response', async () => {
        dbMock.usageReport.findMany.mockResolvedValue([{
            createdAt: new Date('2026-07-13T12:30:00.000Z'),
            data: validData,
        }]);

        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload: {
                sessionId: 'session-a',
                startTime: 1_700_000_000,
                endTime: 1_800_000_000,
                groupBy: 'day',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.session.findFirst).toHaveBeenCalledWith({
            where: { id: 'session-a', accountId: 'account-a' },
        });
        expect(response.json()).toMatchObject({
            usage: [{ tokens: validData.tokens, cost: validData.cost, reportCount: 1 }],
            groupBy: 'day',
            totalReports: 1,
        });
    });

    it('does not copy malformed database values into query diagnostics', async () => {
        dbMock.usageReport.findMany.mockRejectedValueOnce(new Error(
            'private-value account-a session-a attacker@example.invalid',
        ));

        const response = await app.inject({
            method: 'POST',
            url: '/v1/usage/query',
            payload: {},
        });
        const diagnostics = JSON.stringify(logMock.mock.calls);

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({ error: 'Failed to query usage reports' });
        expect(diagnostics).not.toContain('private-value');
        expect(diagnostics).not.toContain('account-a');
        expect(diagnostics).not.toContain('session-a');
        expect(diagnostics).not.toContain('attacker@example.invalid');
    });
});

describe('account profile credential minimization', () => {
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        dbMock.account.findUniqueOrThrow.mockResolvedValue({
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
            githubUser: null,
        });
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('does not advertise retired AI-provider credential state', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/v1/account/profile',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).not.toHaveProperty('connectedServices');
    });
});
