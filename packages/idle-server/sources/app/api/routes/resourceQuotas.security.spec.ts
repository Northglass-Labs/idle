import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

// Public, product-level limits. These values intentionally leave generous room
// for normal use while preventing one account from creating an unbounded relay
// database. Keep these assertions in sync with persistedResourceQuotas.ts.
const EXPECTED_MAX_SESSIONS = 1_000;
const EXPECTED_MAX_ACTIVE_SESSIONS = 100;
const EXPECTED_MAX_MACHINES = 100;

const {
    state,
    dbMock,
    inTxMock,
    afterTxMock,
    allocateUserSeqMock,
    emitUpdateSpy,
    disconnectMachineConnectionsSpy,
    sessionRow,
} = vi.hoisted(() => {
    type Row = Record<string, any>;
    const state = {
        sessions: [] as Row[],
        machines: [] as Row[],
        seqByAccount: new Map<string, number>(),
        txTail: Promise.resolve() as Promise<void>,
        injectSessionCreateRace: false,
        injectMachineCreateRace: false,
    };

    const sessionRow = (data: Row): Row => {
        const now = new Date('2026-01-01T00:00:00.000Z');
        return {
            id: data.id ?? `session-${state.sessions.length + 1}`,
            accountId: data.accountId,
            tag: data.tag,
            metadata: data.metadata ?? 'encrypted-metadata',
            metadataVersion: data.metadataVersion ?? 0,
            agentState: data.agentState ?? null,
            agentStateVersion: data.agentStateVersion ?? 0,
            dataEncryptionKey: data.dataEncryptionKey ?? null,
            seq: data.seq ?? 0,
            active: data.active ?? true,
            lastActiveAt: data.lastActiveAt ?? now,
            createdAt: data.createdAt ?? now,
            updatedAt: data.updatedAt ?? now,
        };
    };

    const machineRow = (data: Row): Row => {
        const now = new Date('2026-01-01T00:00:00.000Z');
        return {
            id: data.id,
            accountId: data.accountId,
            metadata: data.metadata ?? 'encrypted-metadata',
            metadataVersion: data.metadataVersion ?? 1,
            daemonState: data.daemonState ?? null,
            daemonStateVersion: data.daemonStateVersion ?? 0,
            dataEncryptionKey: data.dataEncryptionKey ?? null,
            seq: data.seq ?? 0,
            active: data.active ?? false,
            lastActiveAt: data.lastActiveAt ?? now,
            createdAt: data.createdAt ?? now,
            updatedAt: data.updatedAt ?? now,
        };
    };

    const session = {
        findFirst: vi.fn(async ({ where }: any) => state.sessions.find((row) =>
            (where.accountId === undefined || row.accountId === where.accountId)
            && (where.tag === undefined || row.tag === where.tag)
            && (where.id === undefined || row.id === where.id)
        ) ?? null),
        findMany: vi.fn(async ({ where, take }: any) => state.sessions
            .filter((row) => where?.accountId === undefined || row.accountId === where.accountId)
            .slice(0, take)),
        count: vi.fn(async ({ where }: any) => state.sessions.filter((row) =>
            row.accountId === where.accountId
            && (where.active === undefined || row.active === where.active)
        ).length),
        create: vi.fn(async ({ data }: any) => {
            if (state.injectSessionCreateRace) {
                state.injectSessionCreateRace = false;
                state.sessions.push(sessionRow({ ...data, id: 'concurrent-session' }));
                throw Object.assign(new Error('concurrent session tag'), { code: 'P2002' });
            }
            if (state.sessions.some((row) => row.accountId === data.accountId && row.tag === data.tag)) {
                throw Object.assign(new Error('duplicate session tag'), { code: 'P2002' });
            }
            if (state.sessions.some((row) => row.id === data.id)) {
                throw Object.assign(new Error('duplicate session id'), { code: 'P2002' });
            }
            const row = sessionRow(data);
            state.sessions.push(row);
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const matching = state.sessions.filter((row) =>
                (where.id === undefined || row.id === where.id)
                && (where.accountId === undefined || row.accountId === where.accountId)
            );
            for (const row of matching) Object.assign(row, data);
            return { count: matching.length };
        }),
        delete: vi.fn(async ({ where }: any) => {
            const index = state.sessions.findIndex((row) => row.id === where.id);
            if (index < 0) throw new Error('missing session');
            return state.sessions.splice(index, 1)[0];
        }),
    };

    const machine = {
        findFirst: vi.fn(async ({ where }: any) => state.machines.find((row) =>
            (where.accountId === undefined || row.accountId === where.accountId)
            && (where.id === undefined || row.id === where.id)
        ) ?? null),
        findUnique: vi.fn(async ({ where }: any) => state.machines.find((row) => row.id === where.id) ?? null),
        findMany: vi.fn(async ({ where, take }: any) => state.machines
            .filter((row) => where?.accountId === undefined || row.accountId === where.accountId)
            .slice(0, take)),
        count: vi.fn(async ({ where }: any) => state.machines.filter((row) =>
            row.accountId === where.accountId
            && (where.active === undefined || row.active === where.active)
        ).length),
        create: vi.fn(async ({ data }: any) => {
            if (state.injectMachineCreateRace) {
                state.injectMachineCreateRace = false;
                state.machines.push(machineRow(data));
                throw Object.assign(new Error('concurrent machine id'), { code: 'P2002' });
            }
            if (state.machines.some((row) => row.id === data.id)) {
                throw Object.assign(new Error('duplicate machine id'), { code: 'P2002' });
            }
            const row = machineRow(data);
            state.machines.push(row);
            return row;
        }),
        delete: vi.fn(async ({ where }: any) => {
            const index = state.machines.findIndex((row) => row.id === where.id);
            if (index < 0) throw new Error('missing machine');
            return state.machines.splice(index, 1)[0];
        }),
    };

    const account = {
        update: vi.fn(async ({ where }: any) => {
            const next = (state.seqByAccount.get(where.id) ?? 0) + 1;
            state.seqByAccount.set(where.id, next);
            return { seq: next };
        }),
    };

    const accessKey = { deleteMany: vi.fn(async () => ({ count: 0 })) };
    const dbMock = { session, machine, account, accessKey };

    const inTxMock = vi.fn(async (fn: (tx: any) => Promise<any>) => {
        let release!: () => void;
        const predecessor = state.txTail;
        state.txTail = new Promise<void>((resolve) => { release = resolve; });
        await predecessor;
        const callbacks: Array<() => void> = [];
        const tx = { ...dbMock, __afterTx: callbacks };
        try {
            const result = await fn(tx);
            for (const callback of callbacks) callback();
            return result;
        } finally {
            release();
        }
    });
    const afterTxMock = vi.fn((tx: any, callback: () => void) => tx.__afterTx.push(callback));
    const allocateUserSeqMock = vi.fn(async (accountId: string, tx?: any) => {
        const client = tx ?? dbMock;
        const row = await client.account.update({ where: { id: accountId }, data: { seq: { increment: 1 } } });
        return row.seq;
    });
    const emitUpdateSpy = vi.fn();
    const disconnectMachineConnectionsSpy = vi.fn(async () => undefined);

    return {
        state,
        dbMock,
        inTxMock,
        afterTxMock,
        allocateUserSeqMock,
        emitUpdateSpy,
        disconnectMachineConnectionsSpy,
        sessionRow,
    };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../../storage/inTx', () => ({ inTx: inTxMock, afterTx: afterTxMock }));
vi.mock('../../../storage/seq', () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock('../../events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: emitUpdateSpy,
        emitEphemeral: vi.fn(),
        disconnectMachineConnections: disconnectMachineConnectionsSpy,
    },
    buildNewSessionUpdate: (row: any, seq: number, id: string) => ({ id, seq, body: { t: 'new-session', sessionId: row.id }, createdAt: 0 }),
    buildNewMachineUpdate: (row: any, seq: number, id: string) => ({ id, seq, body: { t: 'new-machine', machineId: row.id }, createdAt: 0 }),
    buildUpdateMachineUpdate: (id: string, seq: number, updateId: string) => ({ id: updateId, seq, body: { t: 'update-machine', machineId: id }, createdAt: 0 }),
    buildDeleteMachineUpdate: (id: string, seq: number, updateId: string) => ({ id: updateId, seq, body: { t: 'delete-machine', machineId: id }, createdAt: 0 }),
    buildSessionActivityEphemeral: vi.fn(),
}));
vi.mock('../../session/sessionDelete', () => ({
    sessionDelete: vi.fn(async ({ uid }: any, sessionId: string) => {
        const index = state.sessions.findIndex((row) => row.id === sessionId && row.accountId === uid);
        if (index < 0) return false;
        state.sessions.splice(index, 1);
        return true;
    }),
}));
vi.mock('../../../utils/log', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { machinesRoutes } from './machinesRoutes';
import { sessionRoutes } from './sessionRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    sessionRoutes(typed);
    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

function addSessions(accountId: string, count: number, active = true): void {
    for (let index = 0; index < count; index += 1) {
        state.sessions.push({
            id: `${accountId}-session-${index}`,
            accountId,
            tag: `${accountId}-tag-${index}`,
            metadata: 'encrypted-metadata',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            seq: 0,
            active,
            lastActiveAt: new Date(0),
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });
    }
}

function addMachines(accountId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        state.machines.push({
            id: `${accountId}-machine-${index}`,
            accountId,
            metadata: 'encrypted-metadata',
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: null,
            seq: 0,
            active: false,
            lastActiveAt: new Date(0),
            createdAt: new Date(0),
            updatedAt: new Date(0),
        });
    }
}

function sessionRequest(app: Fastify, accountId: string, tag: string) {
    return app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { 'x-user-id': accountId },
        payload: { tag, metadata: 'encrypted-metadata' },
    });
}

function machineRequest(app: Fastify, accountId: string, id: string) {
    return app.inject({
        method: 'POST',
        url: '/v1/machines',
        headers: { 'x-user-id': accountId },
        payload: { id, metadata: 'encrypted-metadata' },
    });
}

describe('persisted session and machine quotas', () => {
    let app: Fastify;

    beforeEach(async () => {
        state.sessions = [];
        state.machines = [];
        state.seqByAccount.clear();
        state.txTail = Promise.resolve();
        state.injectSessionCreateRace = false;
        state.injectMachineCreateRace = false;
        vi.clearAllMocks();
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('rejects an out-of-range changedSince timestamp before building a database filter', async () => {
        const response = await app.inject({
            method: 'GET',
            url: `/v2/sessions?changedSince=${Number.MAX_SAFE_INTEGER}`,
            headers: { 'x-user-id': 'account-a' },
        });

        expect(response.statusCode).toBe(400);
        expect(dbMock.session.findMany).not.toHaveBeenCalled();
    });

    it('requires a client-selected id before the v2 create contract can mutate state', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                tag: 'missing-bound-id',
                metadata: 'bound-metadata-ciphertext',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(state.sessions).toHaveLength(0);
    });

    it.each(['/v1/sessions', '/v2/sessions'])(
        'rejects a noncanonical uppercase session UUID at %s before mutating state',
        async (url) => {
            const response = await app.inject({
                method: 'POST',
                url,
                headers: { 'x-user-id': 'account-a' },
                payload: {
                    id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
                    tag: `uppercase-${url}`,
                    metadata: 'bound-metadata-ciphertext',
                },
            });

            expect(response.statusCode).toBe(400);
            expect(state.sessions).toHaveLength(0);
        },
    );

    it('preserves the v2 client-selected session id and initial encrypted state', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                id: '11111111-1111-4111-8111-111111111111',
                tag: 'bound-session',
                metadata: 'bound-metadata-ciphertext',
                agentState: 'bound-agent-state-ciphertext',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
            metadata: 'bound-metadata-ciphertext',
            metadataVersion: 0,
            agentState: 'bound-agent-state-ciphertext',
            agentStateVersion: 0,
        });
        expect(state.sessions[0]).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
            agentState: 'bound-agent-state-ciphertext',
        });
    });

    it('keeps the v1 create route compatible with clients that do not send an id', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                tag: 'legacy-client',
                metadata: 'legacy-client-ciphertext',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session.id).toBe('session-1');
        expect(state.sessions).toHaveLength(1);
    });

    it('returns a generic conflict when another account already owns a client-selected id', async () => {
        state.sessions.push(sessionRow({
            id: '22222222-2222-4222-8222-222222222222',
            accountId: 'account-b',
            tag: 'other-account-session',
        }));

        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                id: '22222222-2222-4222-8222-222222222222',
                tag: 'new-account-a-session',
                metadata: 'bound-metadata-ciphertext',
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: 'Session identifier conflict',
            code: 'SESSION_ID_CONFLICT',
        });
        expect(state.sessions).toHaveLength(1);
    });

    it('keeps same-account tag creation idempotent when the proposed id changes', async () => {
        state.sessions.push(sessionRow({
            id: '33333333-3333-4333-8333-333333333333',
            accountId: 'account-a',
            tag: 'existing-tag',
            metadata: 'existing-ciphertext',
        }));

        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                id: '44444444-4444-4444-8444-444444444444',
                tag: 'existing-tag',
                metadata: 'replacement-ciphertext',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session).toMatchObject({
            id: '33333333-3333-4333-8333-333333333333',
            metadata: 'existing-ciphertext',
        });
        expect(state.sessions).toHaveLength(1);
    });

    it('allows the same opaque tag to identify independent sessions in different accounts', async () => {
        const [first, second] = await Promise.all([
            app.inject({
                method: 'POST',
                url: '/v2/sessions',
                headers: { 'x-user-id': 'account-a' },
                payload: {
                    id: '55555555-5555-4555-8555-555555555555',
                    tag: 'shared-opaque-tag',
                    metadata: 'account-a-ciphertext',
                },
            }),
            app.inject({
                method: 'POST',
                url: '/v2/sessions',
                headers: { 'x-user-id': 'account-b' },
                payload: {
                    id: '66666666-6666-4666-8666-666666666666',
                    tag: 'shared-opaque-tag',
                    metadata: 'account-b-ciphertext',
                },
            }),
        ]);

        expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
        expect(state.sessions.filter((row) => row.tag === 'shared-opaque-tag')).toHaveLength(2);
    });

    it('returns a generic conflict for a same-account UUID collision on a different tag', async () => {
        state.sessions.push(sessionRow({
            id: '77777777-7777-4777-8777-777777777777',
            accountId: 'account-a',
            tag: 'first-tag',
        }));

        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                id: '77777777-7777-4777-8777-777777777777',
                tag: 'different-tag',
                metadata: 'replacement-ciphertext',
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: 'Session identifier conflict',
            code: 'SESSION_ID_CONFLICT',
        });
        expect(state.sessions).toHaveLength(1);
    });

    it('returns an existing same-account tag before inspecting a proposal collision elsewhere', async () => {
        state.sessions.push(
            sessionRow({
                id: '88888888-8888-4888-8888-888888888888',
                accountId: 'account-a',
                tag: 'existing-account-a-tag',
                metadata: 'existing-account-a-ciphertext',
            }),
            sessionRow({
                id: '99999999-9999-4999-8999-999999999999',
                accountId: 'account-b',
                tag: 'account-b-tag',
            }),
        );

        const response = await app.inject({
            method: 'POST',
            url: '/v2/sessions',
            headers: { 'x-user-id': 'account-a' },
            payload: {
                id: '99999999-9999-4999-8999-999999999999',
                tag: 'existing-account-a-tag',
                metadata: 'replacement-ciphertext',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().session).toMatchObject({
            id: '88888888-8888-4888-8888-888888888888',
            metadata: 'existing-account-a-ciphertext',
        });
        expect(state.sessions).toHaveLength(2);
    });

    it('serializes concurrent session creates so one remaining total slot cannot be oversubscribed', async () => {
        addSessions('account-a', EXPECTED_MAX_SESSIONS - 1, false);

        const responses = await Promise.all([
            sessionRequest(app, 'account-a', 'new-one'),
            sessionRequest(app, 'account-a', 'new-two'),
        ]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(state.sessions.filter((row) => row.accountId === 'account-a')).toHaveLength(EXPECTED_MAX_SESSIONS);
    });

    it('keeps duplicate session restore idempotent even for a legacy account already above both caps', async () => {
        addSessions('account-a', EXPECTED_MAX_SESSIONS + 1, true);
        const existing = state.sessions[0];

        const response = await sessionRequest(app, 'account-a', existing.tag);

        expect(response.statusCode).toBe(200);
        expect(response.json().session.id).toBe(existing.id);
        expect(state.sessions).toHaveLength(EXPECTED_MAX_SESSIONS + 1);
    });

    it('recovers a same-tag unique race as an idempotent session restore', async () => {
        state.injectSessionCreateRace = true;

        const response = await sessionRequest(app, 'account-a', 'raced-tag');

        expect(response.statusCode).toBe(200);
        expect(response.json().session.id).toBe('concurrent-session');
        expect(state.sessions.filter((row) => row.accountId === 'account-a' && row.tag === 'raced-tag')).toHaveLength(1);
    });

    it('blocks only new active sessions at the active cap and scopes counts to the authenticated account', async () => {
        addSessions('account-a', EXPECTED_MAX_ACTIVE_SESSIONS, true);

        const [blocked, isolated] = await Promise.all([
            sessionRequest(app, 'account-a', 'over-active-cap'),
            sessionRequest(app, 'account-b', 'first-session'),
        ]);

        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toMatchObject({ code: 'ACTIVE_SESSION_LIMIT_REACHED' });
        expect(isolated.statusCode).toBe(200);
        expect(state.sessions.some((row) => row.accountId === 'account-b')).toBe(true);
    });

    it('frees a total session slot after an owned deletion', async () => {
        addSessions('account-a', EXPECTED_MAX_SESSIONS, false);
        const deletedId = state.sessions[0].id;

        const blocked = await sessionRequest(app, 'account-a', 'before-delete');
        const deletion = await app.inject({
            method: 'DELETE',
            url: `/v1/sessions/${deletedId}`,
            headers: { 'x-user-id': 'account-a' },
        });
        const allowed = await sessionRequest(app, 'account-a', 'after-delete');

        expect(blocked.statusCode).toBe(409);
        expect(deletion.statusCode).toBe(200);
        expect(allowed.statusCode).toBe(200);
        expect(state.sessions.filter((row) => row.accountId === 'account-a')).toHaveLength(EXPECTED_MAX_SESSIONS);
    });

    it('frees an active session slot after an owned archive', async () => {
        addSessions('account-a', EXPECTED_MAX_ACTIVE_SESSIONS, true);
        const archivedId = state.sessions[0].id;

        const blocked = await sessionRequest(app, 'account-a', 'before-archive');
        const archive = await app.inject({
            method: 'POST',
            url: `/v1/sessions/${archivedId}/archive`,
            headers: { 'x-user-id': 'account-a' },
        });
        const allowed = await sessionRequest(app, 'account-a', 'after-archive');

        expect(blocked.statusCode).toBe(409);
        expect(archive.statusCode).toBe(200);
        expect(allowed.statusCode).toBe(200);
        expect(state.sessions.filter((row) => row.accountId === 'account-a' && row.active))
            .toHaveLength(EXPECTED_MAX_ACTIVE_SESSIONS);
    });

    it('serializes concurrent machine creates and preserves duplicate registration at legacy overflow', async () => {
        addMachines('account-a', EXPECTED_MAX_MACHINES - 1);

        const responses = await Promise.all([
            machineRequest(app, 'account-a', 'new-machine-one'),
            machineRequest(app, 'account-a', 'new-machine-two'),
        ]);
        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(state.machines.filter((row) => row.accountId === 'account-a')).toHaveLength(EXPECTED_MAX_MACHINES);

        addMachines('account-a', 2);
        const existing = state.machines[0];
        const duplicate = await machineRequest(app, 'account-a', existing.id);
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().machine.id).toBe(existing.id);
    });

    it('recovers a same-account machine unique race as idempotent registration', async () => {
        state.injectMachineCreateRace = true;

        const response = await machineRequest(app, 'account-a', 'raced-machine');

        expect(response.statusCode).toBe(200);
        expect(response.json().machine.id).toBe('raced-machine');
        expect(state.machines.filter((row) => row.id === 'raced-machine')).toHaveLength(1);
    });

    it('scopes machine quotas per account and reports a global machine-id ownership conflict', async () => {
        addMachines('account-a', EXPECTED_MAX_MACHINES);

        const isolated = await machineRequest(app, 'account-b', 'account-b-first-machine');
        const conflict = await machineRequest(app, 'account-b', state.machines[0].id);

        expect(isolated.statusCode).toBe(200);
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toMatchObject({ code: 'MACHINE_ID_CONFLICT' });
    });

    it('frees a machine slot after owned deletion and bounds legacy-overflow list responses', async () => {
        addMachines('account-a', EXPECTED_MAX_MACHINES + 2);
        const deletedId = state.machines[0].id;

        const list = await app.inject({
            method: 'GET',
            url: '/v1/machines',
            headers: { 'x-user-id': 'account-a' },
        });
        const deletion = await app.inject({
            method: 'DELETE',
            url: `/v1/machines/${deletedId}`,
            headers: { 'x-user-id': 'account-a' },
        });

        expect(list.statusCode).toBe(200);
        expect(list.json()).toHaveLength(EXPECTED_MAX_MACHINES);
        expect(dbMock.machine.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: EXPECTED_MAX_MACHINES }));
        expect(deletion.statusCode).toBe(200);
        expect(disconnectMachineConnectionsSpy).toHaveBeenCalledWith('account-a', deletedId);

        // A legacy overflow account must delete down to the cap before a new
        // allocation is accepted; deleting a single row above the cap is not a bypass.
        const stillBlocked = await machineRequest(app, 'account-a', 'replacement-too-soon');
        expect(stillBlocked.statusCode).toBe(409);
        const otherAccounts = state.machines.filter((row) => row.accountId !== 'account-a');
        const cleanedAccount = state.machines
            .filter((row) => row.accountId === 'account-a')
            .slice(0, EXPECTED_MAX_MACHINES - 1);
        state.machines = [...otherAccounts, ...cleanedAccount];
        const allowed = await machineRequest(app, 'account-a', 'replacement-after-cleanup');
        expect(allowed.statusCode).toBe(200);
    });
});
