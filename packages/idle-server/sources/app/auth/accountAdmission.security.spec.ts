import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
    type Account = {
        id: string;
        publicKey: string;
        authSuspendedAt: Date | null;
    };

    const state = {
        accounts: new Map<string, Account>(),
        admittedAccounts: 0,
        nextId: 1,
    };
    const tx = {
        $queryRaw: vi.fn(async () => [{ admittedAccounts: state.admittedAccounts }]),
        account: {
            findUnique: vi.fn(async ({ where }: any) => (
                state.accounts.get(where.publicKey) ?? null
            )),
            create: vi.fn(async ({ data }: any) => {
                if (state.accounts.has(data.publicKey)) {
                    throw Object.assign(new Error('duplicate account'), { code: 'P2002' });
                }
                const account = {
                    id: `account-${state.nextId++}`,
                    publicKey: data.publicKey,
                    authSuspendedAt: null,
                };
                state.accounts.set(account.publicKey, account);
                return account;
            }),
        },
        deploymentAccountBudget: {
            update: vi.fn(async ({ data }: any) => {
                state.admittedAccounts += data.admittedAccounts.increment;
                return { id: 'accounts', admittedAccounts: state.admittedAccounts };
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (state.admittedAccounts <= where.admittedAccounts.gt) return { count: 0 };
                state.admittedAccounts -= data.admittedAccounts.decrement;
                return { count: 1 };
            }),
        },
    };

    let tail: Promise<unknown> = Promise.resolve();
    const inTx = vi.fn((callback: (client: typeof tx) => Promise<unknown>) => {
        const result = tail.then(() => callback(tx));
        tail = result.then(() => undefined, () => undefined);
        return result;
    });

    const reset = () => {
        state.accounts.clear();
        state.admittedAccounts = 0;
        state.nextId = 1;
        tail = Promise.resolve();
        vi.clearAllMocks();
    };

    return { state, tx, inTx, reset };
});

vi.mock('../../storage/inTx', () => ({ inTx: harness.inTx }));

import {
    admitOrFindAccount,
    releaseAccountAdmission,
} from './accountAdmission';

describe('durable account admission', () => {
    beforeEach(() => {
        harness.reset();
        delete process.env.IDLE_ACCOUNT_REGISTRATION_MODE;
        delete process.env.IDLE_MAX_ACCOUNTS;
    });

    afterEach(() => {
        delete process.env.IDLE_ACCOUNT_REGISTRATION_MODE;
        delete process.env.IDLE_MAX_ACCOUNTS;
    });

    it('admits exactly one first account by default under concurrent registration', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
            admitOrFindAccount(`public-key-${index}`)
        )));

        expect(results.filter((result) => result.kind === 'account')).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'denied')).toHaveLength(7);
        expect(harness.state.admittedAccounts).toBe(1);
        expect(harness.state.accounts).toHaveLength(1);
    });

    it('always authenticates an existing account without consuming admission again', async () => {
        harness.state.accounts.set('known-key', {
            id: 'known-account',
            publicKey: 'known-key',
            authSuspendedAt: null,
        });
        harness.state.admittedAccounts = 1;
        process.env.IDLE_ACCOUNT_REGISTRATION_MODE = 'closed';

        const result = await admitOrFindAccount('known-key');

        expect(result).toMatchObject({ kind: 'account', account: { id: 'known-account' } });
        expect(harness.state.admittedAccounts).toBe(1);
    });

    it('denies an unknown key in closed mode', async () => {
        process.env.IDLE_ACCOUNT_REGISTRATION_MODE = 'closed';

        await expect(admitOrFindAccount('unknown-key')).resolves.toEqual({ kind: 'denied' });
        expect(harness.state.accounts).toHaveLength(0);
        expect(harness.state.admittedAccounts).toBe(0);
    });

    it.each([
        { mode: 'invalid-mode', maxAccounts: undefined },
        { mode: 'open', maxAccounts: '0' },
        { mode: 'open', maxAccounts: 'not-a-number' },
        { mode: 'open', maxAccounts: '1000001' },
    ])('fails unknown-key admission closed for invalid configuration %#', async ({ mode, maxAccounts }) => {
        process.env.IDLE_ACCOUNT_REGISTRATION_MODE = mode;
        if (maxAccounts !== undefined) process.env.IDLE_MAX_ACCOUNTS = maxAccounts;

        await expect(admitOrFindAccount('unknown-key')).resolves.toEqual({ kind: 'denied' });
        expect(harness.state.accounts).toHaveLength(0);
    });

    it('enforces the explicit open-registration deployment cap across callers', async () => {
        process.env.IDLE_ACCOUNT_REGISTRATION_MODE = 'open';
        process.env.IDLE_MAX_ACCOUNTS = '3';

        const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (
            admitOrFindAccount(`public-key-${index}`)
        )));

        expect(results.filter((result) => result.kind === 'account')).toHaveLength(3);
        expect(results.filter((result) => result.kind === 'denied')).toHaveLength(7);
        expect(harness.state.admittedAccounts).toBe(3);
    });

    it('serializes same-key registration without double charging the account cap', async () => {
        process.env.IDLE_ACCOUNT_REGISTRATION_MODE = 'open';
        process.env.IDLE_MAX_ACCOUNTS = '10';

        const results = await Promise.all(Array.from({ length: 8 }, () => (
            admitOrFindAccount('same-public-key')
        )));

        expect(results.every((result) => result.kind === 'account')).toBe(true);
        expect(new Set(results.map((result) => (
            result.kind === 'account' ? result.account.id : 'denied'
        )))).toEqual(new Set(['account-1']));
        expect(harness.state.admittedAccounts).toBe(1);
    });

    it('releases one admission in the account-deletion transaction without underflow', async () => {
        harness.state.admittedAccounts = 1;

        await expect(releaseAccountAdmission(harness.tx as never)).resolves.toBeUndefined();
        expect(harness.state.admittedAccounts).toBe(0);
        await expect(releaseAccountAdmission(harness.tx as never)).rejects.toThrow(
            'Account admission budget is inconsistent',
        );
    });
});
