import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS,
    MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS,
    MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS,
    MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS,
} from '@northglass/idle-wire';

const MAX_SUPPORTED_EPOCH_MILLISECONDS = 253_402_300_799_000;

const {
    state,
    dbMock,
    logSpy,
    emitUpdateSpy,
    emitEphemeralSpy,
    isMachineValidSpy,
    isSessionValidSpy,
    queueMachineUpdateSpy,
    queueSessionUpdateSpy,
} = vi.hoisted(() => {
    const state = {
        machine: {} as any,
        session: {} as any,
        seq: 0,
    };
    const machineMatches = (where: any) => (
        state.machine.id === where.id
        && (where.accountId === undefined || state.machine.accountId === where.accountId)
        && (where.metadataVersion === undefined || state.machine.metadataVersion === where.metadataVersion)
        && (where.daemonStateVersion === undefined || state.machine.daemonStateVersion === where.daemonStateVersion)
        && (where.active === undefined || state.machine.active === where.active)
    );
    const sessionMatches = (where: any) => (
        state.session.id === where.id
        && (where.accountId === undefined || state.session.accountId === where.accountId)
        && (where.metadataVersion === undefined || state.session.metadataVersion === where.metadataVersion)
        && (where.agentStateVersion === undefined || state.session.agentStateVersion === where.agentStateVersion)
    );
    const dbMock = {
        machine: {
            findFirst: vi.fn(async ({ where }: any) => machineMatches(where) ? { ...state.machine } : null),
            count: vi.fn(async () => 1),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (!machineMatches(where)) return { count: 0 };
                Object.assign(state.machine, data);
                return { count: 1 };
            }),
        },
        session: {
            findUnique: vi.fn(async ({ where }: any) => sessionMatches(where) ? { ...state.session } : null),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (!sessionMatches(where)) return { count: 0 };
                Object.assign(state.session, data);
                return { count: 1 };
            }),
            update: vi.fn(async ({ where, data }: any) => {
                if (state.session.id !== where.id) throw new Error('missing session');
                Object.assign(state.session, data);
                return { ...state.session };
            }),
        },
        sessionMessage: {
            findFirst: vi.fn(async () => null),
            create: vi.fn(async ({ data }: any) => ({
                id: 'message-1',
                seq: data.seq,
                content: data.content,
                localId: data.localId,
                createdAt: new Date(0),
                updatedAt: new Date(0),
            })),
        },
        account: {
            update: vi.fn(async () => ({ seq: ++state.seq })),
        },
    };
    return {
        state,
        dbMock,
        logSpy: vi.fn(),
        emitUpdateSpy: vi.fn(),
        emitEphemeralSpy: vi.fn(),
        isMachineValidSpy: vi.fn(async () => true),
        isSessionValidSpy: vi.fn(async () => true),
        queueMachineUpdateSpy: vi.fn(),
        queueSessionUpdateSpy: vi.fn(),
    };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../storage/inTx', () => ({
    inTx: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        const callbacks: Array<() => void | Promise<void>> = [];
        const result = await fn({ ...dbMock, __afterTx: callbacks });
        for (const callback of callbacks) await callback();
        return result;
    }),
    afterTx: vi.fn((tx: any, callback: () => void | Promise<void>) => tx.__afterTx.push(callback)),
}));
vi.mock('../../../storage/seq', () => ({
    allocateUserSeq: vi.fn(async (_accountId: string, tx?: any) => {
        const row = await (tx ?? dbMock).account.update({});
        return row.seq;
    }),
    allocateSessionSeq: vi.fn(async () => 1),
}));
vi.mock('../../monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: vi.fn(() => ({})),
    machineAliveEventsCounter: { inc: vi.fn() },
    sessionAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('../../presence/sessionCache', () => ({
    activityCache: {
        isMachineValid: isMachineValidSpy,
        isSessionValid: isSessionValidSpy,
        queueMachineUpdate: queueMachineUpdateSpy,
        queueSessionUpdate: queueSessionUpdateSpy,
    },
}));
vi.mock('../../limits/persistedResourceQuotas', () => ({
    MAX_ACTIVE_MACHINES_PER_ACCOUNT: 100,
    getMessageStorageQuotaStatus: vi.fn(async () => 'ok'),
    reactivateSessionWithinQuota: vi.fn(async () => true),
}));
vi.mock('../../events/eventRouter', () => ({
    buildMachineActivityEphemeral: vi.fn((_id: string, _active: boolean, activeAt: number) => ({ activeAt })),
    buildSessionActivityEphemeral: vi.fn((_id: string, _active: boolean, activeAt: number) => ({ activeAt })),
    buildUpdateMachineUpdate: vi.fn(() => ({ body: { t: 'update-machine' } })),
    buildUpdateSessionUpdate: vi.fn(() => ({ body: { t: 'update-session' } })),
    buildNewMessageUpdate: vi.fn(),
    eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: emitEphemeralSpy },
}));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../../utils/log', () => ({ log: logSpy }));

import { machineUpdateHandler } from './machineUpdateHandler';
import { sessionUpdateHandler } from './sessionUpdateHandler';

type Handler = (...args: any[]) => Promise<void> | void;

function resetState(): void {
    state.machine = {
        id: 'machine-1',
        accountId: 'account-1',
        metadata: 'old-machine-metadata',
        metadataVersion: 0,
        daemonState: 'old-daemon-state',
        daemonStateVersion: 0,
        active: true,
        lastActiveAt: new Date(0),
    };
    state.session = {
        id: 'session-1',
        accountId: 'account-1',
        metadata: 'old-session-metadata',
        metadataVersion: 0,
        agentState: 'old-agent-state',
        agentStateVersion: 0,
        active: true,
        lastActiveAt: new Date(0),
    };
    state.seq = 0;
}

function registerMachineHandlers(): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const socket = {
        id: 'machine-socket',
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    machineUpdateHandler('account-1', socket, {
        connectionType: 'machine-scoped',
        userId: 'account-1',
        machineId: 'machine-1',
        authorizationGeneration: 1,
        isAuthorizationCurrent: vi.fn(async () => true),
        socket,
    });
    return handlers;
}

function registerSessionHandlers(): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const socket = {
        id: 'session-socket',
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    sessionUpdateHandler('account-1', socket, {
        connectionType: 'session-scoped',
        userId: 'account-1',
        sessionId: 'session-1',
        authorizationGeneration: 1,
        isAuthorizationCurrent: vi.fn(async () => true),
        socket,
    });
    return handlers;
}

async function acknowledge(handler: Handler, data: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
        Promise.resolve(handler(data, resolve)).catch(reject);
    });
}

function expectNoLiveUpdateSideEffects(): void {
    expect(dbMock.machine.findFirst).not.toHaveBeenCalled();
    expect(dbMock.machine.count).not.toHaveBeenCalled();
    expect(dbMock.machine.updateMany).not.toHaveBeenCalled();
    expect(dbMock.session.findUnique).not.toHaveBeenCalled();
    expect(dbMock.session.updateMany).not.toHaveBeenCalled();
    expect(dbMock.session.update).not.toHaveBeenCalled();
    expect(isMachineValidSpy).not.toHaveBeenCalled();
    expect(isSessionValidSpy).not.toHaveBeenCalled();
    expect(queueMachineUpdateSpy).not.toHaveBeenCalled();
    expect(queueSessionUpdateSpy).not.toHaveBeenCalled();
    expect(emitUpdateSpy).not.toHaveBeenCalled();
    expect(emitEphemeralSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
}

describe('live socket update validation boundary', () => {
    beforeEach(() => {
        resetState();
        vi.clearAllMocks();
        isMachineValidSpy.mockResolvedValue(true);
        isSessionValidSpy.mockResolvedValue(true);
    });

    it.each([
        ['machine metadata', () => registerMachineHandlers().get('machine-update-metadata')!, {
            machineId: 'machine-1', metadata: 'm'.repeat(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS), expectedVersion: 0,
        }],
        ['machine state', () => registerMachineHandlers().get('machine-update-state')!, {
            machineId: 'machine-1', daemonState: 'd'.repeat(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS), expectedVersion: 0,
        }],
        ['session metadata', () => registerSessionHandlers().get('update-metadata')!, {
            sid: 'session-1', metadata: 'm'.repeat(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS), expectedVersion: 0,
        }],
        ['session state', () => registerSessionHandlers().get('update-state')!, {
            sid: 'session-1', agentState: 'a'.repeat(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS), expectedVersion: 0,
        }],
    ] as const)('accepts the exact %s ciphertext limit', async (_name, handlerFactory, payload) => {
        await expect(acknowledge(handlerFactory(), payload)).resolves.toMatchObject({ result: 'success', version: 1 });
        expect(emitUpdateSpy).toHaveBeenCalledOnce();
    });

    it.each([
        ['machine metadata', () => registerMachineHandlers().get('machine-update-metadata')!, {
            machineId: 'machine-1', metadata: 'm'.repeat(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS + 1), expectedVersion: 0,
        }],
        ['machine state', () => registerMachineHandlers().get('machine-update-state')!, {
            machineId: 'machine-1', daemonState: 'd'.repeat(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS + 1), expectedVersion: 0,
        }],
        ['session metadata', () => registerSessionHandlers().get('update-metadata')!, {
            sid: 'session-1', metadata: 'm'.repeat(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS + 1), expectedVersion: 0,
        }],
        ['session state', () => registerSessionHandlers().get('update-state')!, {
            sid: 'session-1', agentState: 'a'.repeat(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS + 1), expectedVersion: 0,
        }],
    ] as const)('rejects over-limit %s before database, event, or log work', async (_name, handlerFactory, payload) => {
        await expect(acknowledge(handlerFactory(), payload)).resolves.toMatchObject({ result: 'error' });
        expectNoLiveUpdateSideEffects();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2_147_483_647])(
        'rejects an unsafe optimistic version %s before database work',
        async (expectedVersion) => {
            const machine = registerMachineHandlers().get('machine-update-metadata')!;
            const session = registerSessionHandlers().get('update-metadata')!;

            await expect(acknowledge(machine, {
                machineId: 'machine-1', metadata: 'ciphertext', expectedVersion,
            })).resolves.toMatchObject({ result: 'error' });
            await expect(acknowledge(session, {
                sid: 'session-1', metadata: 'ciphertext', expectedVersion,
            })).resolves.toMatchObject({ result: 'error' });

            expectNoLiveUpdateSideEffects();
        },
    );

    it.each([
        ['missing fields', {}],
        ['null payload', null],
        ['extra fields', { machineId: 'machine-1', metadata: 'ciphertext', expectedVersion: 0, extra: true }],
    ])('rejects malformed machine metadata with %s and no side effects', async (_name, payload) => {
        const handler = registerMachineHandlers().get('machine-update-metadata')!;
        await expect(acknowledge(handler, payload)).resolves.toMatchObject({ result: 'error' });
        expectNoLiveUpdateSideEffects();
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, MAX_SUPPORTED_EPOCH_MILLISECONDS + 1])(
        'rejects invalid activity time %s before cache, database, event, or log work',
        async (time) => {
            const machineHandlers = registerMachineHandlers();
            const sessionHandlers = registerSessionHandlers();

            await machineHandlers.get('machine-alive')!({ machineId: 'machine-1', time });
            await sessionHandlers.get('session-alive')!({ sid: 'session-1', time });
            await sessionHandlers.get('session-end')!({ sid: 'session-1', time });

            expectNoLiveUpdateSideEffects();
        },
    );

    it('accepts the exact supported epoch limit and clamps it before side effects', async () => {
        const machineHandlers = registerMachineHandlers();
        const sessionHandlers = registerSessionHandlers();

        await machineHandlers.get('machine-alive')!({
            machineId: 'machine-1',
            time: MAX_SUPPORTED_EPOCH_MILLISECONDS,
        });
        await sessionHandlers.get('session-alive')!({
            sid: 'session-1',
            time: MAX_SUPPORTED_EPOCH_MILLISECONDS,
        });
        await sessionHandlers.get('session-end')!({
            sid: 'session-1',
            time: MAX_SUPPORTED_EPOCH_MILLISECONDS,
        });

        expect(isMachineValidSpy).toHaveBeenCalledOnce();
        expect(isSessionValidSpy).toHaveBeenCalledOnce();
        expect(queueMachineUpdateSpy).toHaveBeenCalledOnce();
        expect(queueSessionUpdateSpy).toHaveBeenCalledOnce();
        expect(dbMock.session.update).toHaveBeenCalledOnce();
        expect(emitEphemeralSpy).toHaveBeenCalledTimes(3);
        expect(logSpy).not.toHaveBeenCalled();
        const queuedMachineTime = queueMachineUpdateSpy.mock.calls[0]?.[1];
        const queuedSessionTime = queueSessionUpdateSpy.mock.calls[0]?.[1];
        expect(queuedMachineTime).toBeLessThanOrEqual(Date.now());
        expect(queuedSessionTime).toBeLessThanOrEqual(Date.now());
    });

    it('accepts a null encrypted session state', async () => {
        const handler = registerSessionHandlers().get('update-state')!;
        await expect(acknowledge(handler, {
            sid: 'session-1', agentState: null, expectedVersion: 0,
        })).resolves.toMatchObject({ result: 'success', version: 1, agentState: null });
        expect(emitUpdateSpy).toHaveBeenCalledOnce();
    });

    it('does not log live identifiers on a successful legacy message write', async () => {
        const handler = registerSessionHandlers().get('message')!;
        await handler({
            sid: 'session-1',
            message: Buffer.from('ciphertext').toString('base64'),
            localId: 'local-1',
        });

        expect(emitUpdateSpy).toHaveBeenCalledOnce();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('does not expose caught database error values through handler logs', async () => {
        dbMock.machine.findFirst.mockRejectedValueOnce(new Error('credential-like provider detail'));
        const handler = registerMachineHandlers().get('machine-update-metadata')!;

        await expect(acknowledge(handler, {
            machineId: 'machine-1', metadata: 'ciphertext', expectedVersion: 0,
        })).resolves.toMatchObject({ result: 'error', message: 'Internal error' });

        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: 'websocket', level: 'error' }),
            'Machine update failed',
        );
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain('credential-like provider detail');
    });
});
