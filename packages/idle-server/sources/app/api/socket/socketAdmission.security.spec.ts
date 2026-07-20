import { describe, expect, it, vi } from 'vitest';

import { PendingSocketAdmissions } from './pendingSocketAdmissions';
import { prepareSocketAdmission } from './socketAdmission';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function socketHarness() {
    const closeHandlers: Array<() => void> = [];
    return {
        socket: {
            id: 'socket-1',
            data: {} as Record<string, unknown>,
            join: vi.fn(async () => undefined),
            conn: {
                once: vi.fn((_event: string, handler: () => void) => closeHandlers.push(handler)),
            },
        },
        closeHandlers,
    };
}

const currentCredential = {
    userId: 'account-1',
    authorizationGeneration: 7,
    extras: { credentialPurpose: 'rpc-registration-v1' },
};

describe('socket admission linearization', () => {
    it('does not admit a session socket canceled while ownership is pending', async () => {
        const ownership = deferred<number | null>();
        const admissions = new PendingSocketAdmissions();
        const verifyToken = vi.fn(async () => currentCredential);
        const { socket } = socketHarness();

        const resultPromise = prepareSocketAdmission({
            socket,
            token: 'generation-7-token',
            claim: { clientType: 'session-scoped', sessionId: 'session-1' },
            auth: { verifyToken },
            ownership: {
                getSessionGeneration: vi.fn(() => ownership.promise),
                getMachineGeneration: vi.fn(),
            },
            admissions,
        });

        await vi.waitFor(() => expect(admissions.stats().admissions).toBe(1));
        expect(admissions.cancelUser('account-1')).toBe(1);
        ownership.resolve(1_000);

        await expect(resultPromise).resolves.toEqual({
            ok: false,
            error: 'Authentication changed during socket admission',
        });
        expect(socket.join).not.toHaveBeenCalled();
        expect(admissions.stats().admissions).toBe(0);
    });

    it('does not admit a machine socket when final bearer revalidation fails', async () => {
        const admissions = new PendingSocketAdmissions();
        const verifyToken = vi.fn()
            .mockResolvedValueOnce(currentCredential)
            .mockResolvedValueOnce(null);
        const { socket } = socketHarness();

        await expect(prepareSocketAdmission({
            socket,
            token: 'generation-7-token',
            claim: { clientType: 'machine-scoped', machineId: 'machine-1' },
            auth: { verifyToken },
            ownership: {
                getSessionGeneration: vi.fn(),
                getMachineGeneration: vi.fn(async () => 2_000),
            },
            admissions,
        })).resolves.toEqual({
            ok: false,
            error: 'Authentication changed during socket admission',
        });
        expect(socket.join).not.toHaveBeenCalled();
        expect(admissions.stats().admissions).toBe(0);
    });

    it('keeps a successful socket pending until its account-room handoff is promoted', async () => {
        const admissions = new PendingSocketAdmissions();
        const { socket } = socketHarness();

        const result = await prepareSocketAdmission({
            socket,
            token: 'generation-7-token',
            claim: { clientType: 'session-scoped', sessionId: 'session-1' },
            auth: { verifyToken: vi.fn(async () => currentCredential) },
            ownership: {
                getSessionGeneration: vi.fn(async () => 1_000),
                getMachineGeneration: vi.fn(),
            },
            admissions,
        });

        expect(result).toMatchObject({ ok: true });
        expect(socket.join).toHaveBeenCalledWith('user:account-1');
        expect(admissions.stats()).toEqual({ accounts: 1, admissions: 1 });

        const admission = admissions.get('account-1', 'socket-1');
        expect(admission?.promote()).toBe(true);
        expect(admissions.stats()).toEqual({ accounts: 0, admissions: 0 });
    });
});
