import { Prisma, type VoiceCapacityReservation } from '@prisma/client';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

export const VOICE_MAX_CONVERSATIONS = 100;

export type ReserveVoiceCapacityInput = {
    accountId: string;
    requestId: string;
    providerUsedSeconds: number;
    providerConversationCount: number;
    completedProviderConversationIds: string[];
    limitSeconds: number;
    reservationSeconds: number;
    expiresAt: Date;
    now?: Date;
};

export type ReserveVoiceCapacityResult =
    | { kind: 'granted'; reservation: VoiceCapacityReservation }
    | { kind: 'duplicate' }
    | { kind: 'conversation-limit' }
    | { kind: 'duration-limit' };

/**
 * Atomically leases one conversation slot and its maximum possible duration.
 *
 * The Account row lock makes this account-scoped boundary work across relay
 * processes and replicas. Provider history alone cannot do that because a
 * newly minted token is not immediately visible in the provider's listing.
 */
export async function reserveVoiceCapacity(
    input: ReserveVoiceCapacityInput,
): Promise<ReserveVoiceCapacityResult> {
    const now = input.now ?? new Date();

    return inTx(async (tx) => {
        const account = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "Account"
            WHERE "id" = ${input.accountId}
            FOR UPDATE
        `);
        if (account.length !== 1) {
            throw new Error('Voice capacity account does not exist');
        }

        await tx.voiceCapacityReservation.deleteMany({
            where: {
                accountId: input.accountId,
                expiresAt: { lte: now },
            },
        });

        const existing = await tx.voiceCapacityReservation.findUnique({
            where: {
                accountId_requestId: {
                    accountId: input.accountId,
                    requestId: input.requestId,
                },
            },
        });
        if (existing) {
            return { kind: 'duplicate' } as const;
        }

        const outstandingWhere: Prisma.VoiceCapacityReservationWhereInput = {
            accountId: input.accountId,
        };
        if (input.completedProviderConversationIds.length > 0) {
            // Keep the row as an idempotency receipt, but stop charging its
            // reservation once final provider history accounts for it.
            outstandingWhere.OR = [
                { providerConversationId: null },
                { providerConversationId: { notIn: input.completedProviderConversationIds } },
            ];
        }
        const outstanding = await tx.voiceCapacityReservation.aggregate({
            where: outstandingWhere,
            _count: { _all: true },
            _sum: { reservedSeconds: true },
        });
        const reservedCount = outstanding._count._all;
        const reservedSeconds = outstanding._sum.reservedSeconds ?? 0;

        if (input.providerConversationCount + reservedCount >= VOICE_MAX_CONVERSATIONS) {
            return { kind: 'conversation-limit' } as const;
        }
        if (input.providerUsedSeconds + reservedSeconds + input.reservationSeconds > input.limitSeconds) {
            return { kind: 'duration-limit' } as const;
        }

        const reservation = await tx.voiceCapacityReservation.create({
            data: {
                accountId: input.accountId,
                requestId: input.requestId,
                reservedSeconds: input.reservationSeconds,
                expiresAt: input.expiresAt,
            },
        });
        return { kind: 'granted', reservation } as const;
    });
}

/** Bind a committed lease to its provider conversation without storing JWTs. */
export async function bindVoiceCapacityReservation(input: {
    accountId: string;
    reservationId: string;
    providerConversationId: string;
    expiresAt: Date;
}): Promise<boolean> {
    const result = await db.voiceCapacityReservation.updateMany({
        where: {
            id: input.reservationId,
            accountId: input.accountId,
            providerConversationId: null,
        },
        data: {
            providerConversationId: input.providerConversationId,
            expiresAt: input.expiresAt,
        },
    });
    return result.count === 1;
}

/** Release only an unbound lease after a definite provider rejection. */
export async function releaseVoiceCapacityReservation(input: {
    accountId: string;
    reservationId: string;
}): Promise<boolean> {
    const result = await db.voiceCapacityReservation.deleteMany({
        where: {
            id: input.reservationId,
            accountId: input.accountId,
            providerConversationId: null,
        },
    });
    return result.count === 1;
}
