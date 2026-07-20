import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, emitEphemeralMock, logMock } = vi.hoisted(() => ({
    dbMock: {
        session: {
            findFirst: vi.fn(async ({ where }: any) => (
                where.accountId === 'account-a' && where.id === 'session-a'
                    ? { id: 'session-a' }
                    : null
            )),
        },
        usageReport: {
            upsert: vi.fn(async () => ({
                id: 'report-1',
                createdAt: new Date('2026-07-13T00:00:00.000Z'),
                updatedAt: new Date('2026-07-13T00:00:01.000Z'),
            })),
        },
    },
    emitEphemeralMock: vi.fn(),
    logMock: vi.fn(),
}));

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../events/eventRouter', () => ({
    buildUsageEphemeral: vi.fn((sessionId, key, tokens, cost) => ({
        type: 'usage',
        id: sessionId,
        key,
        tokens,
        cost,
    })),
    eventRouter: { emitEphemeral: emitEphemeralMock },
}));
vi.mock('../../../utils/log', () => ({ log: logMock }));

import { usageHandler } from './usageHandler';
import { MAX_USAGE_REPORTS_PER_MINUTE, usageReportRateLimiter } from '../usagePolicy';

type UsageCallbackResponse = {
    success: boolean;
    error?: string;
    reportId?: string;
};
type RegisteredHandler = (data: unknown, callback?: (response: UsageCallbackResponse) => void) => Promise<void>;

const canonicalReport = {
    key: 'claude-session',
    sessionId: 'session-a',
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

function registerUsageHandler(
    accountId = 'account-a',
    authenticatedSessionId = 'session-a',
): RegisteredHandler {
    const handlers = new Map<string, RegisteredHandler>();
    const socket = {
        on: vi.fn((event: string, handler: RegisteredHandler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    usageHandler(accountId, socket, {
        connectionType: 'session-scoped',
        userId: accountId,
        sessionId: authenticatedSessionId,
        authorizationGeneration: 1,
        isAuthorizationCurrent: vi.fn(async () => true),
        rpcRegistrationAuthorized: false,
        socket,
    });
    return handlers.get('usage-report')!;
}

async function invoke(handler: RegisteredHandler, data: unknown): Promise<UsageCallbackResponse> {
    return await new Promise((resolve, reject) => {
        Promise.resolve(handler(data, resolve)).catch(reject);
    });
}

describe('usage-report security boundary', () => {
    beforeEach(() => {
        usageReportRateLimiter.clear();
        vi.clearAllMocks();
        dbMock.session.findFirst.mockImplementation(async ({ where }: any) => (
            where.accountId === 'account-a' && where.id === 'session-a'
                ? { id: 'session-a' }
                : null
        ));
        dbMock.usageReport.upsert.mockResolvedValue({
            id: 'report-1',
            createdAt: new Date('2026-07-13T00:00:00.000Z'),
            updatedAt: new Date('2026-07-13T00:00:01.000Z'),
        });
    });

    it('accepts the canonical CLI payload and stores one session-bound record', async () => {
        const response = await invoke(registerUsageHandler(), canonicalReport);

        expect(response).toMatchObject({ success: true, reportId: 'report-1' });
        expect(dbMock.usageReport.upsert).toHaveBeenCalledWith({
            where: { sessionId: 'session-a', accountId: 'account-a' },
            update: {
                data: {
                    tokens: canonicalReport.tokens,
                    cost: canonicalReport.cost,
                },
                updatedAt: expect.any(Date),
            },
            create: {
                accountId: 'account-a',
                sessionId: 'session-a',
                key: 'claude-session',
                data: {
                    tokens: canonicalReport.tokens,
                    cost: canonicalReport.cost,
                },
            },
        });
        expect(emitEphemeralMock).toHaveBeenCalledOnce();
    });

    it.each([
        ['arbitrary report key', { ...canonicalReport, key: 'attacker-controlled' }],
        ['missing session', { ...canonicalReport, sessionId: null }],
        ['unexpected outer field', { ...canonicalReport, payload: 'retained forever' }],
        ['unexpected token field', {
            ...canonicalReport,
            tokens: { ...canonicalReport.tokens, attacker_dimension: 1 },
        }],
        ['unexpected cost field', {
            ...canonicalReport,
            cost: { ...canonicalReport.cost, attacker_dimension: 1 },
        }],
        ['negative token count', {
            ...canonicalReport,
            tokens: { ...canonicalReport.tokens, input: -1 },
        }],
        ['fractional token count', {
            ...canonicalReport,
            tokens: { ...canonicalReport.tokens, input: 1.5 },
        }],
        ['huge token count', {
            ...canonicalReport,
            tokens: { ...canonicalReport.tokens, total: Number.MAX_SAFE_INTEGER },
        }],
        ['non-finite token count', {
            ...canonicalReport,
            tokens: { ...canonicalReport.tokens, total: Number.POSITIVE_INFINITY },
        }],
        ['negative cost', {
            ...canonicalReport,
            cost: { ...canonicalReport.cost, total: -1 },
        }],
        ['non-finite cost', {
            ...canonicalReport,
            cost: { ...canonicalReport.cost, total: Number.NaN },
        }],
        ['huge cost', {
            ...canonicalReport,
            cost: { ...canonicalReport.cost, total: Number.MAX_VALUE },
        }],
    ])('rejects %s before database or serialized work', async (_label, payload) => {
        const response = await invoke(registerUsageHandler(), payload);

        expect(response).toMatchObject({ success: false });
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
        expect(dbMock.usageReport.upsert).not.toHaveBeenCalled();
        expect(emitEphemeralMock).not.toHaveBeenCalled();
    });

    it('rejects a sibling session through the immutable socket capability without an ownership lookup', async () => {
        const response = await invoke(registerUsageHandler('account-a', 'session-b'), canonicalReport);

        expect(response).toMatchObject({ success: false });
        expect(dbMock.session.findFirst).not.toHaveBeenCalled();
        expect(dbMock.usageReport.upsert).not.toHaveBeenCalled();
    });

    it('does not copy database values or identifiers into failure diagnostics', async () => {
        dbMock.usageReport.upsert.mockRejectedValueOnce(new Error(
            'private-value account-a session-a attacker@example.invalid',
        ));

        const response = await invoke(registerUsageHandler(), canonicalReport);
        const diagnostics = JSON.stringify(logMock.mock.calls);

        expect(response).toEqual({ success: false, error: 'Failed to save usage report' });
        expect(diagnostics).not.toContain('private-value');
        expect(diagnostics).not.toContain('account-a');
        expect(diagnostics).not.toContain('session-a');
        expect(diagnostics).not.toContain('attacker@example.invalid');
    });

    it('shares one bounded rate budget across many sockets for the same account', async () => {
        const responses = await Promise.all(Array.from(
            { length: MAX_USAGE_REPORTS_PER_MINUTE + 1 },
            () => invoke(registerUsageHandler(), canonicalReport),
        ));

        expect(responses.filter((response) => response.success)).toHaveLength(MAX_USAGE_REPORTS_PER_MINUTE);
        expect(responses.at(-1)).toMatchObject({ success: false });
        expect(dbMock.usageReport.upsert).toHaveBeenCalledTimes(MAX_USAGE_REPORTS_PER_MINUTE);
    });
});
