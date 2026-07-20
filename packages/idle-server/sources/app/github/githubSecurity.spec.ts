import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../context';

const {
    dbMock,
    txMock,
    decryptStringMock,
    emitUpdateMock,
    logMock,
} = vi.hoisted(() => {
    const txMock = {
        account: { updateMany: vi.fn() },
        githubUser: { delete: vi.fn() },
    };
    const dbMock = {
        account: { findUnique: vi.fn() },
        githubUser: { findUnique: vi.fn() },
        $transaction: vi.fn(),
    };

    return {
        dbMock,
        txMock,
        decryptStringMock: vi.fn(),
        emitUpdateMock: vi.fn(),
        logMock: vi.fn(),
    };
});

vi.mock('../../storage/db', () => ({ db: dbMock }));
vi.mock('../../modules/encrypt', () => ({
    decryptString: decryptStringMock,
}));
vi.mock('../../storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 9) }));
vi.mock('../events/eventRouter', () => ({
    buildUpdateAccountUpdate: vi.fn(() => ({ type: 'account-update' })),
    eventRouter: { emitUpdate: emitUpdateMock },
}));
vi.mock('../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../utils/log', () => ({ log: logMock }));

import { githubDisconnect } from './githubDisconnect';

const context = (uid: string) => ({ uid }) as Context;

describe('GitHub account security boundaries', () => {
    const originalClientId = process.env.GITHUB_CLIENT_ID;
    const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GITHUB_CLIENT_ID = 'client-id';
        process.env.GITHUB_CLIENT_SECRET = 'client-secret';
        dbMock.account.findUnique.mockResolvedValue({ githubUserId: '12345' });
        dbMock.githubUser.findUnique.mockResolvedValue({ token: new Uint8Array([1, 2, 3]) });
        dbMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => callback(txMock));
        decryptStringMock.mockReturnValue('github-access-token');
        txMock.account.updateMany.mockResolvedValue({ count: 1 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (originalClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
        else process.env.GITHUB_CLIENT_ID = originalClientId;
        if (originalClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
        else process.env.GITHUB_CLIENT_SECRET = originalClientSecret;
    });

    it('revokes the provider authorization before deleting the local connection', async () => {
        await expect(githubDisconnect(context('owner-idle-account'))).resolves.toBeUndefined();

        expect(decryptStringMock).toHaveBeenCalledWith(
            ['user', 'owner-idle-account', 'github', 'token'],
            new Uint8Array([1, 2, 3]),
        );
        expect(fetch).toHaveBeenCalledWith(
            'https://api.github.com/applications/client-id/grant',
            expect.objectContaining({
                method: 'DELETE',
                headers: expect.objectContaining({
                    Accept: 'application/vnd.github+json',
                    Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
                    'Content-Type': 'application/json',
                    'X-GitHub-Api-Version': '2022-11-28',
                }),
                body: JSON.stringify({ access_token: 'github-access-token' }),
            }),
        );
        expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it('removes the local connection when the provider token is already absent', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);

        await expect(githubDisconnect(context('owner-idle-account'))).resolves.toBeUndefined();

        expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the local connection when provider revocation fails', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 422 } as Response);

        await expect(githubDisconnect(context('owner-idle-account')))
            .rejects.toThrow('Failed to revoke GitHub access token');

        expect(dbMock.$transaction).not.toHaveBeenCalled();
        expect(emitUpdateMock).not.toHaveBeenCalled();
    });

    it('does not clear a newer GitHub binding after revoking the old grant', async () => {
        txMock.account.updateMany.mockResolvedValue({ count: 0 });

        await expect(githubDisconnect(context('owner-idle-account')))
            .rejects.toThrow('GitHub connection changed while disconnecting');

        expect(txMock.account.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'owner-idle-account', githubUserId: '12345' },
        }));
        expect(txMock.githubUser.delete).not.toHaveBeenCalled();
        expect(emitUpdateMock).not.toHaveBeenCalled();
    });

    it('does not write Idle or GitHub account identifiers to disconnect logs', async () => {
        dbMock.account.findUnique.mockResolvedValue({ githubUserId: '987654321' });

        await githubDisconnect(context('idle-account-private-id'));

        const logs = JSON.stringify(logMock.mock.calls);
        expect(logs).not.toContain('idle-account-private-id');
        expect(logs).not.toContain('987654321');
    });
});
