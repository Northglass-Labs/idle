import { Prisma, type Account } from '@prisma/client';
import { z } from 'zod';
import { inTx, type Tx } from '@/storage/inTx';

const RegistrationModeSchema = z.enum(['first-account', 'closed', 'open']);
const MaxAccountsSchema = z.coerce.number().int().min(1).max(1_000_000);
const DEFAULT_MAX_ACCOUNTS = 1_000;

type AdmittedAccount = Pick<Account, 'id' | 'authSuspendedAt'>;

export type AccountAdmissionResult =
    | { kind: 'account'; account: AdmittedAccount }
    | { kind: 'denied' };

function registrationLimit(): number | null {
    const modeValue = process.env.IDLE_ACCOUNT_REGISTRATION_MODE ?? 'first-account';
    const mode = RegistrationModeSchema.safeParse(modeValue);
    if (!mode.success || mode.data === 'closed') return null;
    if (mode.data === 'first-account') return 1;

    const configured = process.env.IDLE_MAX_ACCOUNTS;
    if (configured === undefined) return DEFAULT_MAX_ACCOUNTS;
    const parsed = MaxAccountsSchema.safeParse(configured);
    return parsed.success ? parsed.data : null;
}

/**
 * Finds an existing signing-key account or atomically admits a new one.
 *
 * The singleton row lock serializes unknown-key registration across relay
 * replicas. Known keys do not consume another slot and remain available even
 * when registration is later closed.
 */
export async function admitOrFindAccount(publicKey: string): Promise<AccountAdmissionResult> {
    return inTx(async (tx) => {
        const existing = await tx.account.findUnique({
            where: { publicKey },
            select: { id: true, authSuspendedAt: true },
        });
        if (existing) return { kind: 'account', account: existing } as const;

        const limit = registrationLimit();
        if (limit === null) return { kind: 'denied' } as const;

        const budget = await tx.$queryRaw<Array<{ admittedAccounts: number }>>(Prisma.sql`
            SELECT "admittedAccounts"
            FROM "DeploymentAccountBudget"
            WHERE "id" = 'accounts'
            FOR UPDATE
        `);
        if (budget.length !== 1) {
            throw new Error('Account admission budget is unavailable');
        }

        // Another transaction may have created the same key while this one
        // waited for the admission lock.
        const afterLock = await tx.account.findUnique({
            where: { publicKey },
            select: { id: true, authSuspendedAt: true },
        });
        if (afterLock) return { kind: 'account', account: afterLock } as const;
        if (budget[0].admittedAccounts >= limit) return { kind: 'denied' } as const;

        const account = await tx.account.create({
            data: { publicKey },
            select: { id: true, authSuspendedAt: true },
        });
        await tx.deploymentAccountBudget.update({
            where: { id: 'accounts' },
            data: { admittedAccounts: { increment: 1 } },
        });
        return { kind: 'account', account } as const;
    });
}

/** Decrements the admission counter in the same transaction as account deletion. */
export async function releaseAccountAdmission(tx: Tx): Promise<void> {
    const released = await tx.deploymentAccountBudget.updateMany({
        where: {
            id: 'accounts',
            admittedAccounts: { gt: 0 },
        },
        data: { admittedAccounts: { decrement: 1 } },
    });
    if (released.count !== 1) {
        throw new Error('Account admission budget is inconsistent');
    }
}
