import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
    type Row = {
        id: string;
        accountId: string;
        requestId: string;
        reservedSeconds: number;
        providerConversationId: string | null;
        expiresAt: Date;
        createdAt: Date;
    };

    const state = { rows: [] as Row[], nextId: 1 };
    const tx = {
        $queryRaw: vi.fn(async () => [{ id: 'account-1' }]),
        voiceCapacityReservation: {
            deleteMany: vi.fn(async ({ where }: any) => {
                const before = state.rows.length;
                state.rows = state.rows.filter((row) => {
                    if (row.accountId !== where.accountId) return true;
                    const expired = Boolean(
                        where.expiresAt?.lte && row.expiresAt <= where.expiresAt.lte
                    ) || where.OR?.some((entry: any) => (
                        entry.expiresAt?.lte && row.expiresAt <= entry.expiresAt.lte
                    ));
                    const accounted = where.OR?.some((entry: any) => (
                        entry.providerConversationId?.in?.includes(row.providerConversationId)
                    ));
                    return !expired && !accounted;
                });
                return { count: before - state.rows.length };
            }),
            findUnique: vi.fn(async ({ where }: any) => state.rows.find((row) => (
                row.accountId === where.accountId_requestId.accountId
                && row.requestId === where.accountId_requestId.requestId
            )) ?? null),
            aggregate: vi.fn(async ({ where }: any) => {
                const completedIds = where.OR?.find((entry: any) => (
                    entry.providerConversationId?.notIn
                ))?.providerConversationId.notIn ?? [];
                const rows = state.rows.filter((row) => (
                    row.accountId === where.accountId
                    && (
                        completedIds.length === 0
                        || row.providerConversationId === null
                        || !completedIds.includes(row.providerConversationId)
                    )
                ));
                return {
                    _count: { _all: rows.length },
                    _sum: { reservedSeconds: rows.reduce((sum, row) => sum + row.reservedSeconds, 0) },
                };
            }),
            create: vi.fn(async ({ data }: any) => {
                const row: Row = {
                    id: `reservation-${state.nextId++}`,
                    providerConversationId: null,
                    createdAt: new Date(),
                    ...data,
                };
                state.rows.push(row);
                return row;
            }),
        },
    };

    let tail: Promise<unknown> = Promise.resolve();
    const inTx = vi.fn((callback: (client: typeof tx) => Promise<unknown>) => {
        const result = tail.then(() => callback(tx));
        tail = result.then(() => undefined, () => undefined);
        return result;
    });

    const db = {
        voiceCapacityReservation: {
            updateMany: vi.fn(async ({ where, data }: any) => {
                const rows = state.rows.filter((row) => (
                    row.id === where.id
                    && row.accountId === where.accountId
                    && row.providerConversationId === where.providerConversationId
                ));
                for (const row of rows) Object.assign(row, data);
                return { count: rows.length };
            }),
            deleteMany: vi.fn(async ({ where }: any) => {
                const before = state.rows.length;
                state.rows = state.rows.filter((row) => !(
                    row.id === where.id
                    && row.accountId === where.accountId
                    && row.providerConversationId === where.providerConversationId
                ));
                return { count: before - state.rows.length };
            }),
        },
    };

    const reset = () => {
        state.rows = [];
        state.nextId = 1;
        tail = Promise.resolve();
        vi.clearAllMocks();
    };

    return { state, tx, inTx, db, reset };
});

vi.mock('../../storage/inTx', () => ({ inTx: harness.inTx }));
vi.mock('../../storage/db', () => ({ db: harness.db }));

import {
    bindVoiceCapacityReservation,
    releaseVoiceCapacityReservation,
    reserveVoiceCapacity,
} from './voiceCapacity';

const now = new Date('2026-07-14T12:00:00.000Z');

function request(overrides: Record<string, unknown> = {}) {
    return {
        accountId: 'account-1',
        requestId: crypto.randomUUID(),
        providerUsedSeconds: 0,
        providerConversationCount: 0,
        completedProviderConversationIds: [],
        limitSeconds: 3_600,
        reservationSeconds: 60,
        expiresAt: new Date(now.getTime() + 86_400_000),
        now,
        ...overrides,
    };
}

describe('durable voice capacity reservations', () => {
    beforeEach(harness.reset);

    it('lets only one concurrent request consume the final conversation slot', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => (
            reserveVoiceCapacity(request({ providerConversationCount: 99 }))
        )));

        expect(results.filter((result) => result.kind === 'granted')).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'conversation-limit')).toHaveLength(7);
        expect(harness.state.rows).toHaveLength(1);
    });

    it('atomically reserves the final bounded duration grant', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => (
            reserveVoiceCapacity(request({ providerUsedSeconds: 3_540 }))
        )));

        expect(results.filter((result) => result.kind === 'granted')).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'duration-limit')).toHaveLength(7);
        expect(harness.state.rows[0]?.reservedSeconds).toBe(60);
    });

    it('does not allocate or mint twice for one idempotency coordinate', async () => {
        const coordinate = 'voice-request-1';
        const first = await reserveVoiceCapacity(request({ requestId: coordinate }));
        const second = await reserveVoiceCapacity(request({ requestId: coordinate }));

        expect(first.kind).toBe('granted');
        expect(second.kind).toBe('duplicate');
        expect(harness.state.rows).toHaveLength(1);
    });

    it('reconciles completed provider history before projecting new capacity', async () => {
        const completedRequestId = 'voice-request-completed';
        const first = await reserveVoiceCapacity(request({ requestId: completedRequestId }));
        expect(first.kind).toBe('granted');
        if (first.kind !== 'granted') throw new Error('expected reservation');
        await bindVoiceCapacityReservation({
            accountId: 'account-1',
            reservationId: first.reservation.id,
            providerConversationId: 'conv_completed1',
            expiresAt: new Date(now.getTime() + 172_800_000),
        });

        const next = await reserveVoiceCapacity(request({
            providerConversationCount: 99,
            completedProviderConversationIds: ['conv_completed1'],
        }));

        expect(next.kind).toBe('granted');
        expect(harness.state.rows).toHaveLength(2);
        expect(harness.state.rows[0]?.providerConversationId).toBe('conv_completed1');
        expect(harness.state.rows[1]?.providerConversationId).toBeNull();

        const replay = await reserveVoiceCapacity(request({
            requestId: completedRequestId,
            providerConversationCount: 99,
            completedProviderConversationIds: ['conv_completed1'],
        }));
        expect(replay.kind).toBe('duplicate');
    });

    it('releases only a still-unbound reservation after a definite rejection', async () => {
        const result = await reserveVoiceCapacity(request());
        expect(result.kind).toBe('granted');
        if (result.kind !== 'granted') throw new Error('expected reservation');

        await expect(releaseVoiceCapacityReservation({
            accountId: 'account-1',
            reservationId: result.reservation.id,
        })).resolves.toBe(true);
        expect(harness.state.rows).toHaveLength(0);
    });
});
