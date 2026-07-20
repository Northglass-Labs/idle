import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, resetSession } = vi.hoisted(() => {
    let session: any;
    let initialReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    let initialReadsReady: Promise<void>;

    const resetSession = () => {
        session = {
            id: 'session-1',
            accountId: 'owner-account',
            metadata: 'old-metadata',
            metadataVersion: 0,
            agentState: 'old-state',
            agentStateVersion: 0,
        };
        initialReads = 0;
        initialReadsReady = new Promise<void>((resolve) => {
            releaseInitialReads = resolve;
        });
    };
    resetSession();

    const matches = (where: any) => (
        session.id === where.id &&
        (where.accountId === undefined || session.accountId === where.accountId) &&
        (where.metadataVersion === undefined || session.metadataVersion === where.metadataVersion) &&
        (where.agentStateVersion === undefined || session.agentStateVersion === where.agentStateVersion)
    );

    const dbMock = {
        session: {
            findUnique: vi.fn(async ({ where }: any) => {
                if (!matches(where)) return null;
                const snapshot = { ...session };
                initialReads += 1;
                if (initialReads <= 2) {
                    if (initialReads === 2) releaseInitialReads?.();
                    await initialReadsReady;
                }
                return snapshot;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (!matches(where)) return { count: 0 };
                Object.assign(session, data);
                return { count: 1 };
            }),
        },
    };

    return { dbMock, resetSession };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../storage/seq', () => ({
    allocateUserSeq: vi.fn(async () => 1),
    allocateSessionSeq: vi.fn(async () => 1),
}));
vi.mock('../../monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: vi.fn(() => ({})),
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('../../presence/sessionCache', () => ({
    activityCache: {
        isSessionValid: vi.fn(),
        queueSessionUpdate: vi.fn(),
    },
}));
vi.mock('../../presence/sessionActivityUpdate', () => ({ buildActivityResumeUpdateArgs: vi.fn() }));
vi.mock('../../events/eventRouter', () => ({
    buildActivityResumeUpdateArgs: vi.fn(),
    buildNewMessageUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(() => ({ type: 'session-update' })),
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral: vi.fn() },
}));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (data: any, callback: (response: any) => void) => Promise<void>;

function registerHandlers() {
    const handlers = new Map<string, Handler>();
    const socket = {
        id: 'socket-1',
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    sessionUpdateHandler('owner-account', socket, {
        connectionType: 'session-scoped',
        sessionId: 'session-1',
        userId: 'owner-account',
        authorizationGeneration: 1,
        isAuthorizationCurrent: vi.fn(async () => true),
        socket,
    } as any);
    return handlers;
}

describe('session optimistic concurrency conflict responses', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSession();
    });

    it.each([
        {
            event: 'update-metadata',
            requestField: 'metadata',
            responseField: 'metadata',
            versionField: 'metadataVersion',
            first: 'first-metadata',
            second: 'second-metadata',
        },
        {
            event: 'update-state',
            requestField: 'agentState',
            responseField: 'agentState',
            versionField: 'agentStateVersion',
            first: 'first-state',
            second: 'second-state',
        },
    ])('returns the committed value after a concurrent $event conflict', async ({
        event,
        requestField,
        responseField,
        versionField,
        first,
        second,
    }) => {
        const handler = registerHandlers().get(event)!;
        const responses: any[] = [];
        const invoke = (value: string) => handler(
            { sid: 'session-1', [requestField]: value, expectedVersion: 0 },
            (response) => responses.push(response),
        );

        await Promise.all([invoke(first), invoke(second)]);

        const success = responses.find((response) => response.result === 'success');
        const conflict = responses.find((response) => response.result === 'version-mismatch');
        expect(success).toEqual(expect.objectContaining({ version: 1 }));
        expect(conflict).toEqual(expect.objectContaining({
            version: 1,
            [responseField]: success[responseField],
        }));
        expect(dbMock.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'session-1',
                accountId: 'owner-account',
                [versionField]: 0,
            }),
        }));
    });
});
