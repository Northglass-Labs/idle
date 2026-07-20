import { beforeEach, describe, expect, it, vi } from 'vitest';

const EXPECTED_MAX_ACTIVE_MACHINES = 25;

const { state, dbMock, inTxMock, afterTxMock, emitUpdateSpy } = vi.hoisted(() => {
    const state = {
        machines: [] as any[],
        seq: 0,
        txTail: Promise.resolve() as Promise<void>,
    };
    const matches = (row: any, where: any) => (
        (where.id === undefined || row.id === where.id)
        && (where.accountId === undefined || row.accountId === where.accountId)
        && (where.daemonStateVersion === undefined || row.daemonStateVersion === where.daemonStateVersion)
        && (where.active === undefined || row.active === where.active)
    );
    const machine = {
        findFirst: vi.fn(async ({ where }: any) => {
            const row = state.machines.find((candidate) => matches(candidate, where));
            return row ? { ...row } : null;
        }),
        count: vi.fn(async ({ where }: any) => state.machines.filter((row) => matches(row, where)).length),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const row = state.machines.find((candidate) => matches(candidate, where));
            if (!row) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
        }),
    };
    const account = {
        update: vi.fn(async () => ({ seq: ++state.seq })),
    };
    const dbMock = { machine, account };
    const inTxMock = vi.fn(async (fn: (tx: any) => Promise<any>) => {
        let release!: () => void;
        const predecessor = state.txTail;
        state.txTail = new Promise<void>((resolve) => { release = resolve; });
        await predecessor;
        const callbacks: Array<() => void> = [];
        try {
            const result = await fn({ ...dbMock, __afterTx: callbacks });
            for (const callback of callbacks) callback();
            return result;
        } finally {
            release();
        }
    });
    const afterTxMock = vi.fn((tx: any, callback: () => void) => tx.__afterTx.push(callback));
    return { state, dbMock, inTxMock, afterTxMock, emitUpdateSpy: vi.fn() };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../storage/inTx', () => ({ inTx: inTxMock, afterTx: afterTxMock }));
vi.mock('../../../storage/seq', () => ({
    allocateUserSeq: vi.fn(async (_accountId: string, tx?: any) => {
        const row = await (tx ?? dbMock).account.update({});
        return row.seq;
    }),
}));
vi.mock('../../monitoring/metrics2', () => ({
    getMetricsLabelsFromSocket: vi.fn(() => ({})),
    machineAliveEventsCounter: { inc: vi.fn() },
    websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('../../presence/sessionCache', () => ({
    activityCache: { isMachineValid: vi.fn(), queueMachineUpdate: vi.fn() },
}));
vi.mock('../../events/eventRouter', () => ({
    buildMachineActivityEphemeral: vi.fn(),
    buildUpdateMachineUpdate: vi.fn(() => ({ body: { t: 'update-machine' } })),
    eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: vi.fn() },
}));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { machineUpdateHandler } from './machineUpdateHandler';

type Handler = (data: any, callback: (response: any) => void) => Promise<void>;

function addMachine(accountId: string, id: string, active: boolean): void {
    state.machines.push({
        id,
        accountId,
        daemonState: 'old-state',
        daemonStateVersion: 0,
        active,
        lastActiveAt: new Date(0),
    });
}

function registerHandler(machineId = 'target'): Handler {
    const handlers = new Map<string, Handler>();
    const socket = {
        on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
        disconnect: vi.fn(),
    } as any;
    machineUpdateHandler('account-a', socket, {
        connectionType: 'machine-scoped',
        userId: 'account-a',
        machineId,
        authorizationGeneration: 1,
        isAuthorizationCurrent: vi.fn(async () => true),
        socket,
    });
    return handlers.get('machine-update-state')!;
}

function invoke(handler: Handler, machineId: string): Promise<any> {
    return new Promise((resolve, reject) => {
        handler({ machineId, daemonState: 'new-state', expectedVersion: 0 }, resolve).catch(reject);
    });
}

describe('active machine quota', () => {
    beforeEach(() => {
        state.machines = [];
        state.seq = 0;
        state.txTail = Promise.resolve();
        vi.clearAllMocks();
    });

    it('refuses an inactive-to-active transition at the account cap without changing state', async () => {
        for (let index = 0; index < EXPECTED_MAX_ACTIVE_MACHINES; index += 1) {
            addMachine('account-a', `active-${index}`, true);
        }
        addMachine('account-a', 'target', false);

        const response = await invoke(registerHandler(), 'target');

        expect(response).toMatchObject({ result: 'error', code: 'ACTIVE_MACHINE_LIMIT_REACHED' });
        expect(state.machines.find((row) => row.id === 'target')).toMatchObject({
            active: false,
            daemonStateVersion: 0,
        });
        expect(emitUpdateSpy).not.toHaveBeenCalled();
    });

    it('scopes active counts per account and allows a normal transition below the cap', async () => {
        for (let index = 0; index < EXPECTED_MAX_ACTIVE_MACHINES; index += 1) {
            addMachine('account-b', `other-${index}`, true);
        }
        addMachine('account-a', 'target', false);

        const response = await invoke(registerHandler(), 'target');

        expect(response).toMatchObject({ result: 'success', version: 1 });
        expect(state.machines.find((row) => row.id === 'target')).toMatchObject({ active: true, daemonStateVersion: 1 });
    });

    it('grandfathers updates to an already-active machine on a legacy overflow account', async () => {
        for (let index = 0; index < EXPECTED_MAX_ACTIVE_MACHINES + 1; index += 1) {
            addMachine('account-a', `active-${index}`, true);
        }

        const response = await invoke(registerHandler('active-0'), 'active-0');

        expect(response).toMatchObject({ result: 'success', version: 1 });
        expect(state.machines.find((row) => row.id === 'active-0')?.daemonState).toBe('new-state');
    });

    it('serializes two concurrent activations competing for one remaining slot', async () => {
        for (let index = 0; index < EXPECTED_MAX_ACTIVE_MACHINES - 1; index += 1) {
            addMachine('account-a', `active-${index}`, true);
        }
        addMachine('account-a', 'target-one', false);
        addMachine('account-a', 'target-two', false);
        const responses = await Promise.all([
            invoke(registerHandler('target-one'), 'target-one'),
            invoke(registerHandler('target-two'), 'target-two'),
        ]);

        expect(responses.map((response) => response.result).sort()).toEqual(['error', 'success']);
        expect(state.machines.filter((row) => row.accountId === 'account-a' && row.active)).toHaveLength(EXPECTED_MAX_ACTIVE_MACHINES);
    });
});
