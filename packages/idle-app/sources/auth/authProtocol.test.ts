import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
    buildAuthChallengeMessage,
    encodeAuthPairingPayload,
} from '@northglass/idle-wire';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock('expo-crypto', () => ({
    getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)),
}));
vi.mock('@/encryption/libsodium.lib', async () => {
    const { default: sodium } = await import('libsodium-wrappers');
    await sodium.ready;
    return { default: sodium };
});
vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://idle.test' }));
vi.mock('@/sync/apiSocket', () => ({ getIdleClientId: () => 'app/test' }));

import { encodeBase64 } from '../encryption/base64';
import { encryptBox } from '../encryption/libsodium';
import { authAccountApprove } from './authAccountApprove';
import { authGetToken } from './authGetToken';
import { authQRStart } from './authQRStart';
import { authQRWait } from './authQRWait';
import {
    createAccountPairingApproval,
    decryptAccountPairingCredentials,
    decryptPairingCredentials,
} from './authPairing';
import { signAuthChallenge } from './authChallenge';

beforeAll(async () => {
    await sodium.ready;
});

beforeEach(() => {
    mocks.post.mockReset();
});

describe('mobile auth protocol v3', () => {
    it('signs the challenge for the locally selected relay audience', () => {
        const secret = new Uint8Array(require('node:crypto').randomBytes(32));
        const challengeId = '123e4567-e89b-12d3-a456-426614174000';
        const challenge = 'AQIDBA==';
        const proof = signAuthChallenge(secret, 'https://idle.test', challengeId, challenge);

        expect(sodium.crypto_sign_verify_detached(
            proof.signature,
            buildAuthChallengeMessage('https://idle.test', challengeId, challenge),
            proof.publicKey,
        )).toBe(true);
        expect(sodium.crypto_sign_verify_detached(
            proof.signature,
            buildAuthChallengeMessage('https://other.test', challengeId, challenge),
            proof.publicKey,
        )).toBe(false);
    });

    it('requests a server challenge before minting a token', async () => {
        const secret = new Uint8Array(require('node:crypto').randomBytes(32));
        const challengeId = '123e4567-e89b-12d3-a456-426614174000';
        const challenge = 'AQIDBA==';
        mocks.post
            .mockResolvedValueOnce({ data: { version: 3, challengeId, challenge } })
            .mockResolvedValueOnce({ data: { success: true, token: 'token-value' } });

        await expect(authGetToken(secret)).resolves.toBe('token-value');
        expect(mocks.post.mock.calls[0][0]).toBe('https://idle.test/v1/auth/challenge');
        const proof = mocks.post.mock.calls[1][1] as Record<string, unknown>;
        expect(mocks.post.mock.calls[1][0]).toBe('https://idle.test/v1/auth');
        expect(proof).toHaveProperty('version', 3);
        expect(proof).toHaveProperty('challengeId', challengeId);
        expect(proof).not.toHaveProperty('challenge');
    });

    it('rejects a downgrade response without signing it', async () => {
        const secret = new Uint8Array(require('node:crypto').randomBytes(32));
        mocks.post.mockResolvedValueOnce({
            data: {
                version: 2,
                challengeId: '123e4567-e89b-12d3-a456-426614174000',
                challenge: 'AQIDBA==',
            },
        });

        await expect(authGetToken(secret)).rejects.toThrow(/version/);
        expect(mocks.post).toHaveBeenCalledTimes(1);
    });

    it('unwraps the encrypted token and encrypted account response', () => {
        const keypair = sodium.crypto_box_keypair();
        const accountSecret = new Uint8Array(require('node:crypto').randomBytes(32));
        const inner = encryptBox(accountSecret, keypair.publicKey);
        const outer = encryptBox(encodeAuthPairingPayload({
            version: 2,
            token: 'token-value',
            response: encodeBase64(inner),
        }), keypair.publicKey);

        expect(decryptPairingCredentials(encodeBase64(outer), keypair.privateKey)).toEqual({
            token: 'token-value',
            secret: accountSecret,
        });
    });

    it('signs account pairing credentials for one relay and one requester', () => {
        const requester = sodium.crypto_box_keypair();
        const accountSecret = new Uint8Array(require('node:crypto').randomBytes(32));
        const approval = createAccountPairingApproval({
            relayAudience: 'https://IDLE.TEST:443',
            requesterPublicKey: requester.publicKey,
            accountSecret,
            token: 'current-app-bearer',
        });

        const credentials = decryptAccountPairingCredentials(
            encodeBase64(approval.response),
            requester.privateKey,
            'https://idle.test',
            requester.publicKey,
        );
        expect(credentials).toMatchObject({
            token: 'current-app-bearer',
            secret: accountSecret,
            verificationCode: approval.verificationCode,
        });
        expect(credentials?.accountPublicKey).toEqual(
            sodium.crypto_sign_seed_keypair(accountSecret).publicKey,
        );
    });

    it('rejects account pairing credentials replayed across relays or requesters', () => {
        const requester = sodium.crypto_box_keypair();
        const otherRequester = sodium.crypto_box_keypair();
        const approval = createAccountPairingApproval({
            relayAudience: 'https://idle.test',
            requesterPublicKey: requester.publicKey,
            accountSecret: new Uint8Array(require('node:crypto').randomBytes(32)),
            token: 'current-app-bearer',
        });
        const encrypted = encodeBase64(approval.response);

        expect(decryptAccountPairingCredentials(
            encrypted,
            requester.privateKey,
            'https://other.test',
            requester.publicKey,
        )).toBeNull();
        expect(decryptAccountPairingCredentials(
            encrypted,
            requester.privateKey,
            'https://idle.test',
            otherRequester.publicKey,
        )).toBeNull();
    });

    it('sends an opaque signed v3 account approval and returns its verification code', async () => {
        const requester = sodium.crypto_box_keypair();
        const accountSecret = new Uint8Array(require('node:crypto').randomBytes(32));
        mocks.post.mockResolvedValueOnce({ data: { success: true } });

        const verificationCode = await authAccountApprove(
            'current-app-bearer',
            requester.publicKey,
            accountSecret,
        );

        expect(mocks.post).toHaveBeenCalledTimes(1);
        const [url, body, config] = mocks.post.mock.calls[0];
        expect(url).toBe('https://idle.test/v1/auth/account/response');
        expect(body).toMatchObject({
            version: 3,
            publicKey: encodeBase64(requester.publicKey),
            response: expect.any(String),
        });
        expect(config).toMatchObject({
            headers: { Authorization: 'Bearer current-app-bearer' },
        });
        expect(decryptAccountPairingCredentials(
            body.response,
            requester.privateKey,
            'https://idle.test',
            requester.publicKey,
        )).toMatchObject({
            token: 'current-app-bearer',
            secret: accountSecret,
            verificationCode,
        });
    });

    it('hard-cuts mobile account requests over to v3', async () => {
        const requester = sodium.crypto_box_keypair();
        mocks.post.mockResolvedValueOnce({ data: { state: 'requested' } });

        await expect(authQRStart({
            publicKey: requester.publicKey,
            secretKey: requester.privateKey,
        })).resolves.toBe(true);
        expect(mocks.post.mock.calls[0][1]).toEqual({
            version: 3,
            publicKey: encodeBase64(requester.publicKey),
        });
    });

    it('verifies a v3 mobile account response before returning credentials', async () => {
        const requester = sodium.crypto_box_keypair();
        const accountSecret = new Uint8Array(require('node:crypto').randomBytes(32));
        const approval = createAccountPairingApproval({
            relayAudience: 'https://idle.test',
            requesterPublicKey: requester.publicKey,
            accountSecret,
            token: 'current-app-bearer',
        });
        mocks.post.mockResolvedValueOnce({
            data: { state: 'authorized', response: encodeBase64(approval.response) },
        });

        await expect(authQRWait({
            publicKey: requester.publicKey,
            secretKey: requester.privateKey,
        })).resolves.toMatchObject({
            token: 'current-app-bearer',
            secret: accountSecret,
            verificationCode: approval.verificationCode,
        });
        expect(mocks.post.mock.calls[0][1]).toEqual({
            version: 3,
            publicKey: encodeBase64(requester.publicKey),
        });
    });

    it('paces account-pairing polls and stops after the pairing lease expires', async () => {
        vi.useFakeTimers();
        const requester = sodium.crypto_box_keypair();
        let cancelled = false;
        let settled = false;
        mocks.post.mockResolvedValue({ data: { state: 'requested' } });

        const waiting = authQRWait(
            { publicKey: requester.publicKey, secretKey: requester.privateKey },
            undefined,
            () => cancelled,
        ).then((result) => {
            settled = true;
            return result;
        });

        try {
            await vi.advanceTimersByTimeAsync(2_999);
            const callsBeforeThreeSeconds = mocks.post.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 2_999);
            const settledAtLeaseExpiry = settled;

            cancelled = true;
            await vi.advanceTimersByTimeAsync(3_000);
            await waiting;

            expect(callsBeforeThreeSeconds).toBe(1);
            expect(settledAtLeaseExpiry).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
