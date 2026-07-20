import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
    MAX_MESSAGE_BYTES_PER_ACCOUNT,
    MAX_MESSAGE_BYTES_PER_SESSION,
    MAX_MESSAGES_PER_ACCOUNT,
    MAX_MESSAGES_PER_SESSION,
} from '../../limits/persistedResourceQuotas';

const { state, dbMock, inTxMock } = vi.hoisted(() => {
    const state = {
        sessions: [] as any[],
        messages: [] as any[],
        messageCountBySession: new Map<string, number>(),
        messageCountByAccount: new Map<string, number>(),
        messageBytesBySession: new Map<string, number>(),
        messageBytesByAccount: new Map<string, number>(),
    };
    const matches = (row: any, where: any) => (
        (where.id === undefined || row.id === where.id)
        && (where.accountId === undefined || row.accountId === where.accountId)
        && (where.active === undefined || row.active === where.active)
    );
    const session = {
        findUnique: vi.fn(async ({ where }: any) => {
            const row = state.sessions.find((candidate) => matches(candidate, where));
            return row ? { ...row } : null;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
            const row = state.sessions.find((candidate) => matches(candidate, where));
            return row ? { ...row } : null;
        }),
        count: vi.fn(async ({ where }: any) => state.sessions.filter((row) => matches(row, where)).length),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const row = state.sessions.find((candidate) => matches(candidate, where));
            if (!row) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
        }),
    };
    const sessionMessage = {
        findFirst: vi.fn(async () => null),
        count: vi.fn(async ({ where }: any) => {
            if (where.sessionId) {
                return state.messageCountBySession.get(where.sessionId)
                    ?? state.messages.filter((row) => row.sessionId === where.sessionId).length;
            }
            const accountId = where.session?.accountId;
            if (accountId) {
                return state.messageCountByAccount.get(accountId)
                    ?? state.messages.filter((message) => state.sessions.some((session) => (
                        session.id === message.sessionId && session.accountId === accountId
                    ))).length;
            }
            return state.messages.length;
        }),
        aggregate: vi.fn(async ({ where }: any) => {
            const sessionId = where.sessionId as string | undefined;
            if (sessionId) {
                return {
                    _sum: {
                        contentBytes: state.messageBytesBySession.get(sessionId)
                            ?? state.messages
                                .filter((row) => row.sessionId === sessionId)
                                .reduce((sum, row) => sum + (row.contentBytes ?? 0), 0),
                    },
                };
            }
            const accountId = where.session?.accountId as string | undefined;
            return {
                _sum: {
                    contentBytes: accountId === undefined
                        ? 0
                        : state.messageBytesByAccount.get(accountId)
                            ?? state.messages
                                .filter((message) => state.sessions.some((session) => (
                                    session.id === message.sessionId && session.accountId === accountId
                                )))
                                .reduce((sum, row) => sum + (row.contentBytes ?? 0), 0),
                },
            };
        }),
        create: vi.fn(async ({ data }: any) => {
            const row = {
                id: `message-${state.messages.length + 1}`,
                ...data,
                createdAt: new Date(0),
                updatedAt: new Date(0),
            };
            state.messages.push(row);
            return row;
        }),
    };
    const dbMock = { session, sessionMessage };
    const inTxMock = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(dbMock));
    return { state, dbMock, inTxMock };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../storage/inTx', () => ({ inTx: inTxMock }));
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
    activityCache: { isSessionValid: vi.fn(), queueSessionUpdate: vi.fn() },
}));
vi.mock('../../events/eventRouter', () => ({
    buildNewMessageUpdate: vi.fn(() => ({ body: { t: 'new-message' } })),
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral: vi.fn() },
}));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (data: any) => Promise<void>;
const encryptedFixture = (value: string) => Buffer.from(value).toString('base64');

function addSession(accountId: string, id: string, active: boolean): void {
    state.sessions.push({
        id,
        accountId,
        active,
        lastActiveAt: new Date(0),
        metadataVersion: 0,
        agentStateVersion: 0,
    });
}

function registerMessageHandler(connection: Record<string, unknown> = {
    connectionType: 'session-scoped',
    userId: 'account-a',
    sessionId: 'target',
    authorizationGeneration: 1,
    isAuthorizationCurrent: vi.fn(async () => true),
}): Handler {
    const handlers = new Map<string, Handler>();
    const socket = {
        id: 'socket-1',
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    sessionUpdateHandler('account-a', socket, { ...connection, socket } as any);
    return handlers.get('message')!;
}

describe('session message reactivation quota', () => {
    beforeEach(() => {
        state.sessions = [];
        state.messages = [];
        state.messageCountBySession.clear();
        state.messageCountByAccount.clear();
        state.messageBytesBySession.clear();
        state.messageBytesByAccount.clear();
        vi.clearAllMocks();
    });

    it('persists the message but leaves an inactive session inactive at the active cap', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT; index += 1) {
            addSession('account-a', `active-${index}`, true);
        }
        addSession('account-a', 'target', false);

        await registerMessageHandler()({ sid: 'target', message: encryptedFixture('encrypted-message') });
        await vi.waitFor(() => expect(inTxMock).toHaveBeenCalled());

        expect(state.messages).toHaveLength(1);
        expect(state.sessions.find((row) => row.id === 'target')?.active).toBe(false);
    });

    it('reactivates an owned session below the cap and ignores other-account activity', async () => {
        for (let index = 0; index < MAX_ACTIVE_SESSIONS_PER_ACCOUNT; index += 1) {
            addSession('account-b', `other-${index}`, true);
        }
        addSession('account-a', 'target', false);

        await registerMessageHandler()({ sid: 'target', message: encryptedFixture('encrypted-message') });
        await vi.waitFor(() => expect(state.sessions.find((row) => row.id === 'target')?.active).toBe(true));

        expect(state.messages).toHaveLength(1);
    });

    it('does not let the legacy socket path allocate beyond session or account message caps', async () => {
        addSession('account-a', 'target', true);
        const handler = registerMessageHandler();

        state.messageCountBySession.set('target', MAX_MESSAGES_PER_SESSION);
        await handler({ sid: 'target', message: encryptedFixture('encrypted-session-overflow'), localId: 'session-new' });
        expect(state.messages).toHaveLength(0);

        state.messageCountBySession.delete('target');
        state.messageCountByAccount.set('account-a', MAX_MESSAGES_PER_ACCOUNT);
        await handler({ sid: 'target', message: encryptedFixture('encrypted-account-overflow'), localId: 'account-new' });
        expect(state.messages).toHaveLength(0);
    });

    it('does not let the legacy socket path allocate beyond session or account byte caps', async () => {
        addSession('account-a', 'target', true);
        const handler = registerMessageHandler();

        state.messageBytesBySession.set('target', MAX_MESSAGE_BYTES_PER_SESSION);
        await handler({ sid: 'target', message: encryptedFixture('encrypted-session-overflow'), localId: 'session-new' });
        expect(state.messages).toHaveLength(0);

        state.messageBytesBySession.delete('target');
        state.messageBytesByAccount.set('account-a', MAX_MESSAGE_BYTES_PER_ACCOUNT);
        await handler({ sid: 'target', message: encryptedFixture('encrypted-account-overflow'), localId: 'account-new' });
        expect(state.messages).toHaveLength(0);

        state.messageBytesByAccount.delete('account-a');
        const content = encryptedFixture('within-budget');
        await handler({ sid: 'target', message: content, localId: 'accepted' });
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]?.contentBytes).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('rejects malformed payloads and cross-session or machine-scoped legacy writes', async () => {
        addSession('account-a', 'target', true);

        await registerMessageHandler()({ sid: 'target', message: { not: 'ciphertext' } });
        await registerMessageHandler({
            connectionType: 'session-scoped',
            userId: 'account-a',
            sessionId: 'different-session',
            authorizationGeneration: 1,
            isAuthorizationCurrent: vi.fn(async () => true),
        })({ sid: 'target', message: encryptedFixture('cross-session') });
        await registerMessageHandler({
            connectionType: 'machine-scoped',
            userId: 'account-a',
            machineId: 'machine-a',
            authorizationGeneration: 1,
            isAuthorizationCurrent: vi.fn(async () => true),
        })({ sid: 'target', message: encryptedFixture('machine-write') });

        expect(state.messages).toHaveLength(0);
        expect(inTxMock).not.toHaveBeenCalled();
    });
});
