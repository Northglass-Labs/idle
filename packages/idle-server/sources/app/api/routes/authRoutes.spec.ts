import fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildAuthChallengeMessage,
    decodeAuthPairingPayload,
} from '@northglass/idle-wire';

import { type Fastify } from '../types';

const { accountAdmissionMock, authMock, dbMock, resetState, state } = vi.hoisted(() => {
    type PairingRow = {
        id: string;
        publicKey: string;
        supportsV2?: boolean;
        response: string | null;
        responseAccountId: string | null;
        createdAt: Date;
        updatedAt: Date;
    };
    const state = {
        repeatKeys: new Map<string, { key: string; value: string; expiresAt: Date }>(),
        terminalRequests: new Map<string, PairingRow>(),
        accountRequests: new Map<string, PairingRow>(),
        accounts: new Map<string, {
            id: string;
            publicKey: string;
            authSuspendedAt: Date | null;
        }>(),
        tokenCount: 0,
    };
    const accountAdmissionMock = vi.fn();
    const resetState = () => {
        state.repeatKeys.clear();
        state.terminalRequests.clear();
        state.accountRequests.clear();
        state.accounts.clear();
        state.tokenCount = 0;
        authMock.createToken.mockReset().mockImplementation(async () => `token-${++state.tokenCount}`);
        accountAdmissionMock.mockReset().mockImplementation(async (publicKey: string) => {
            let account = state.accounts.get(publicKey);
            if (!account) {
                account = {
                    id: `user-${publicKey.slice(0, 8)}`,
                    publicKey,
                    authSuspendedAt: null,
                };
                state.accounts.set(publicKey, account);
            }
            return { kind: 'account', account };
        });
    };
    const matchesPairingWhere = (row: PairingRow, where: any) => {
        if (where.id !== undefined && row.id !== where.id) return false;
        if (where.publicKey !== undefined && row.publicKey !== where.publicKey) return false;
        if (where.response === null && row.response !== null) return false;
        if (where.response?.not === null && row.response === null) return false;
        if (where.responseAccountId?.not === null && row.responseAccountId === null) return false;
        if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
        if (where.createdAt?.gte && !(row.createdAt >= where.createdAt.gte)) return false;
        return true;
    };
    const pairingModel = (rows: Map<string, PairingRow>, terminal: boolean) => ({
        upsert: vi.fn(async ({ where, update, create }: any) => {
            const existing = rows.get(where.publicKey);
            if (existing) {
                if (Object.keys(update).length > 0) {
                    Object.assign(existing, update, { updatedAt: new Date() });
                }
                return existing;
            }
            const now = new Date();
            const row: PairingRow = {
                id: `${terminal ? 'terminal' : 'account'}-${rows.size + 1}`,
                publicKey: create.publicKey,
                supportsV2: terminal ? Boolean(create.supportsV2) : undefined,
                response: null,
                responseAccountId: null,
                createdAt: now,
                updatedAt: now,
            };
            rows.set(row.publicKey, row);
            return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
            if (where.publicKey) return rows.get(where.publicKey) ?? null;
            return [...rows.values()].find((row) => row.id === where.id) ?? null;
        }),
        findMany: vi.fn(async () => [...rows.values()]),
        update: vi.fn(async ({ where, data }: any) => {
            const row = [...rows.values()].find((candidate) => candidate.id === where.id);
            if (!row) throw new Error('missing pairing row');
            Object.assign(row, data, { updatedAt: new Date() });
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
            const matches = [...rows.values()].filter((row) => matchesPairingWhere(row, where));
            for (const row of matches) {
                Object.assign(row, data, { updatedAt: new Date() });
            }
            return { count: matches.length };
        }),
        deleteMany: vi.fn(async ({ where }: any) => {
            const matches = [...rows.values()].filter((row) => matchesPairingWhere(row, where));
            for (const row of matches) rows.delete(row.publicKey);
            return { count: matches.length };
        }),
    });
    const dbMock: any = {
        repeatKey: {
            create: vi.fn(async ({ data }: any) => {
                if (state.repeatKeys.has(data.key)) {
                    throw Object.assign(new Error('duplicate'), { code: 'P2002' });
                }
                const row = { key: data.key, value: data.value, expiresAt: data.expiresAt };
                state.repeatKeys.set(row.key, row);
                return row;
            }),
            findUnique: vi.fn(async ({ where }: any) => state.repeatKeys.get(where.key) ?? null),
            deleteMany: vi.fn(async ({ where }: any) => {
                const matches = [...state.repeatKeys.values()].filter((row) => {
                    if (where.key !== undefined && row.key !== where.key) return false;
                    if (where.value !== undefined && row.value !== where.value) return false;
                    if (where.expiresAt?.gte && row.expiresAt < where.expiresAt.gte) return false;
                    if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) return false;
                    return true;
                });
                for (const row of matches) {
                    state.repeatKeys.delete(row.key);
                }
                return { count: matches.length };
            }),
        },
        account: {
            upsert: vi.fn(async ({ where, create }: any) => {
                const existing = state.accounts.get(where.publicKey);
                if (existing) return existing;
                const account = {
                    id: `user-${where.publicKey.slice(0, 8)}`,
                    publicKey: create.publicKey,
                    authSuspendedAt: null,
                };
                state.accounts.set(account.publicKey, account);
                return account;
            }),
        },
        terminalAuthRequest: pairingModel(state.terminalRequests, true),
        accountAuthRequest: pairingModel(state.accountRequests, false),
    };
    const authMock = {
        createToken: vi.fn(async () => `token-${++state.tokenCount}`),
    };
    return { accountAdmissionMock, authMock, dbMock, resetState, state };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../auth/auth', () => ({ auth: authMock }));
vi.mock('../../auth/accountAdmission', () => ({
    admitOrFindAccount: accountAdmissionMock,
}));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));

import { authRoutes } from './authRoutes';

async function createApp(options: {
    globalRateLimitMax?: number;
    registerSyncProbe?: boolean;
} = {}): Promise<Fastify> {
    const app = fastify();
    if (options.globalRateLimitMax !== undefined) {
        await app.register(fastifyRateLimit, {
            max: options.globalRateLimitMax,
            timeWindow: '1 minute',
        });
    }
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    authRoutes(typed);
    if (options.registerSyncProbe) {
        typed.get('/_test/session-sync', async () => ({ ok: true }));
    }
    await typed.ready();
    return typed;
}

function decryptBoxBundle(bundleBase64: string, secretKey: Uint8Array): Uint8Array | null {
    const bundle = new Uint8Array(Buffer.from(bundleBase64, 'base64'));
    const publicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
    const nonceStart = tweetnacl.box.publicKeyLength;
    const nonce = bundle.slice(nonceStart, nonceStart + tweetnacl.box.nonceLength);
    const ciphertext = bundle.slice(nonceStart + tweetnacl.box.nonceLength);
    return tweetnacl.box.open(ciphertext, nonce, publicKey, secretKey);
}

const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;
const AUTH_AUDIENCE = 'https://relay.test';

function seedPendingPairingRequest(
    kind: 'terminal' | 'account',
    publicKey: Uint8Array,
    createdAt: Date,
) {
    const publicKeyHex = Buffer.from(publicKey).toString('hex').toUpperCase();
    const rows = kind === 'terminal' ? state.terminalRequests : state.accountRequests;
    const row = {
        id: `stale-${kind}`,
        publicKey: publicKeyHex,
        supportsV2: kind === 'terminal' ? true : undefined,
        response: null,
        responseAccountId: null,
        createdAt,
        updatedAt: createdAt,
    };
    rows.set(publicKeyHex, row);
    return row;
}

describe('authRoutes protocol security', () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
        process.env.IDLE_AUTH_AUDIENCE = AUTH_AUDIENCE;
    });
    afterEach(async () => {
        delete process.env.IDLE_AUTH_AUDIENCE;
        if (app) await app.close();
    });

    it('mints a token only for a fresh server challenge and rejects replay', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        const challengeResponse = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload: { version: 3, publicKey },
        });
        expect(challengeResponse.statusCode).toBe(200);
        const challenge = challengeResponse.json<{ version: 3; challengeId: string; challenge: string }>();
        expect(challenge.version).toBe(3);
        const signature = Buffer.from(tweetnacl.sign.detached(
            buildAuthChallengeMessage(AUTH_AUDIENCE, challenge.challengeId, challenge.challenge),
            keypair.secretKey,
        )).toString('base64');
        const proof = { version: 3, publicKey, challengeId: challenge.challengeId, signature };

        const first = await app.inject({ method: 'POST', url: '/v1/auth', payload: proof });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({ success: true, token: 'token-1' });

        const replay = await app.inject({ method: 'POST', url: '/v1/auth', payload: proof });
        expect(replay.statusCode).toBe(401);
        expect(state.tokenCount).toBe(1);
    });

    it('rejects a live proof signed for another relay even with spoofed host headers', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        const challengeResponse = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload: { version: 3, publicKey },
        });
        const challenge = challengeResponse.json<{ challengeId: string; challenge: string }>();
        const signature = Buffer.from(tweetnacl.sign.detached(
            buildAuthChallengeMessage(
                'https://attacker-relay.test',
                challenge.challengeId,
                challenge.challenge,
            ),
            keypair.secretKey,
        )).toString('base64');

        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            headers: {
                host: 'attacker-relay.test',
                'x-forwarded-host': 'attacker-relay.test',
                'x-forwarded-proto': 'https',
            },
            payload: {
                version: 3,
                publicKey,
                challengeId: challenge.challengeId,
                signature,
            },
        });

        expect(response.statusCode).toBe(401);
        expect(authMock.createToken).not.toHaveBeenCalled();
    });

    it.each([
        { publicKey: 'dGVzdA==' },
        { version: 2, publicKey: 'dGVzdA==' },
    ])('rejects a missing or downgraded challenge protocol version', async (payload) => {
        app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload,
        });
        expect(response.statusCode).toBe(400);
    });

    it('rejects the legacy client-chosen challenge protocol', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const challenge = tweetnacl.randomBytes(32);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: {
                publicKey: Buffer.from(keypair.publicKey).toString('base64'),
                challenge: Buffer.from(challenge).toString('base64'),
                signature: Buffer.from(tweetnacl.sign.detached(challenge, keypair.secretKey)).toString('base64'),
            },
        });
        expect(response.statusCode).toBe(400);
        expect(state.tokenCount).toBe(0);
    });

    it('rejects a suspended account signing credential without revealing account status', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        accountAdmissionMock.mockResolvedValueOnce({
            kind: 'account',
            account: {
                id: 'suspended-user',
                authSuspendedAt: new Date(),
            },
        });

        const challengeResponse = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload: { version: 3, publicKey },
        });
        const challenge = challengeResponse.json<{ challengeId: string; challenge: string }>();
        const signature = Buffer.from(tweetnacl.sign.detached(
            buildAuthChallengeMessage(AUTH_AUDIENCE, challenge.challengeId, challenge.challenge),
            keypair.secretKey,
        )).toString('base64');

        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey, challengeId: challenge.challengeId, signature },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid credentials' });
        expect(authMock.createToken).not.toHaveBeenCalled();
        expect(accountAdmissionMock).toHaveBeenCalledWith(expect.any(String));
    });

    it('returns the same credential rejection when a valid unknown key is not admitted', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        accountAdmissionMock.mockResolvedValueOnce({ kind: 'denied' });
        const challengeResponse = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload: { version: 3, publicKey },
        });
        const challenge = challengeResponse.json<{ challengeId: string; challenge: string }>();
        const signature = Buffer.from(tweetnacl.sign.detached(
            buildAuthChallengeMessage(AUTH_AUDIENCE, challenge.challengeId, challenge.challenge),
            keypair.secretKey,
        )).toString('base64');

        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey, challengeId: challenge.challengeId, signature },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid credentials' });
        expect(authMock.createToken).not.toHaveBeenCalled();
    });

    it('maps a suspension race during token minting to the same public credential rejection', async () => {
        app = await createApp();
        const keypair = tweetnacl.sign.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        authMock.createToken.mockRejectedValueOnce(Object.assign(
            new Error('account authentication unavailable'),
            { code: 'ACCOUNT_AUTHENTICATION_UNAVAILABLE' },
        ));
        const challengeResponse = await app.inject({
            method: 'POST',
            url: '/v1/auth/challenge',
            payload: { version: 3, publicKey },
        });
        const challenge = challengeResponse.json<{ challengeId: string; challenge: string }>();
        const signature = Buffer.from(tweetnacl.sign.detached(
            buildAuthChallengeMessage(AUTH_AUDIENCE, challenge.challengeId, challenge.challenge),
            keypair.secretKey,
        )).toString('base64');

        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: { version: 3, publicKey, challengeId: challenge.challengeId, signature },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid credentials' });
    });

    it.each([
        ['terminal', '/v1/auth/request', '/v1/auth/response', { supportsV2: true }],
        ['account', '/v1/auth/account/request', '/v1/auth/account/response', { version: 3 }],
    ] as const)('protects and atomically consumes %s pairing credentials', async (kind, requestUrl, responseUrl, extra) => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        const opaqueInnerResponse = Buffer.from('already-encrypted-account-secret').toString('base64');

        expect((await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey,
                response: opaqueInnerResponse,
            },
        })).statusCode).toBe(200);

        const authorized = await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        });
        expect(authorized.statusCode).toBe(200);
        const body = authorized.json<{ state: string; response: string; token?: string }>();
        expect(body.state).toBe('authorized');
        expect(body).not.toHaveProperty('token');
        if (kind === 'terminal') {
            const decrypted = decryptBoxBundle(body.response, keypair.secretKey);
            expect(decrypted).not.toBeNull();
            expect(decodeAuthPairingPayload(decrypted!)).toEqual({
                version: 2,
                token: 'token-1',
                rpcRegistrationToken: 'token-2',
                response: opaqueInnerResponse,
            });
        } else {
            expect(body.response).toBe(opaqueInnerResponse);
        }

        const secondPoll = await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        });
        expect(secondPoll.json()).toEqual({ state: 'requested' });
        expect(state.tokenCount).toBe(kind === 'terminal' ? 2 : 0);
    });

    it('hard-cuts account pairing to v3 and relays the approver-signed ciphertext unchanged', async () => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        const signedCiphertext = Buffer.from('opaque-signed-v3-account-payload').toString('base64');

        const legacyRequest = await app.inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { publicKey },
        });
        expect(legacyRequest.statusCode).toBe(400);

        const requested = await app.inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { version: 3, publicKey },
        });
        expect(requested.json()).toEqual({ state: 'requested' });

        const approved = await app.inject({
            method: 'POST',
            url: '/v1/auth/account/response',
            headers: { 'x-user-id': 'account-1' },
            payload: { version: 3, publicKey, response: signedCiphertext },
        });
        expect(approved.statusCode).toBe(200);
        expect(state.tokenCount).toBe(0);

        const authorized = await app.inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { version: 3, publicKey },
        });
        expect(authorized.json()).toEqual({
            state: 'authorized',
            response: signedCiphertext,
        });
        expect(state.tokenCount).toBe(0);
    });

    it('isolates account-pairing polls from the ordinary relay request budget', async () => {
        app = await createApp({ globalRateLimitMax: 2, registerSyncProbe: true });
        const publicKey = Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64');

        const pairingStatuses: number[] = [];
        for (let index = 0; index < 31; index += 1) {
            pairingStatuses.push((await app.inject({
                method: 'POST',
                url: '/v1/auth/account/request',
                payload: { version: 3, publicKey },
            })).statusCode);
        }

        expect(pairingStatuses.slice(0, 30)).toEqual(Array(30).fill(200));
        expect(pairingStatuses[30]).toBe(429);
        expect((await app.inject({
            method: 'GET',
            url: '/_test/session-sync',
        })).statusCode).toBe(200);
    });

    it('returns a conflict when an account pairing approval has already been claimed', async () => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        await app.inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { version: 3, publicKey },
        });
        const approval = {
            method: 'POST' as const,
            url: '/v1/auth/account/response',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                version: 3,
                publicKey,
                response: Buffer.from('opaque-approval').toString('base64'),
            },
        };

        expect((await app.inject(approval)).statusCode).toBe(200);
        const duplicate = await app.inject(approval);
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toEqual({ error: 'Pairing request already approved' });

        await app.inject({
            method: 'POST',
            url: '/v1/auth/account/request',
            payload: { version: 3, publicKey },
        });
        const duplicateAfterConsumption = await app.inject(approval);
        expect(duplicateAfterConsumption.statusCode).toBe(409);
        expect(duplicateAfterConsumption.json()).toEqual({
            error: 'Pairing request already approved',
        });
    });

    it.each([
        ['terminal', '/v1/auth/response'],
        ['account', '/v1/auth/account/response'],
    ] as const)('rejects stale %s approvals exactly like missing requests', async (kind, responseUrl) => {
        app = await createApp();
        const staleKeypair = tweetnacl.box.keyPair();
        const missingKeypair = tweetnacl.box.keyPair();
        const staleRow = seedPendingPairingRequest(
            kind,
            staleKeypair.publicKey,
            new Date(Date.now() - PAIRING_REQUEST_TTL_MS - 1),
        );
        const response = Buffer.from('opaque-approval').toString('base64');

        const missing = await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey: Buffer.from(missingKeypair.publicKey).toString('base64'),
                response,
            },
        });
        const stale = await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey: Buffer.from(staleKeypair.publicKey).toString('base64'),
                response,
            },
        });

        expect(missing.statusCode).toBe(404);
        expect(stale.statusCode).toBe(missing.statusCode);
        expect(stale.json()).toEqual(missing.json());
        expect(staleRow.response).toBeNull();
        expect(state.tokenCount).toBe(0);
        expect(state.repeatKeys.size).toBe(0);
    });

    it('reports a retained stale terminal request exactly like a missing request', async () => {
        app = await createApp();
        const staleKeypair = tweetnacl.box.keyPair();
        const missingKeypair = tweetnacl.box.keyPair();
        seedPendingPairingRequest(
            'terminal',
            staleKeypair.publicKey,
            new Date(Date.now() - PAIRING_REQUEST_TTL_MS - 1),
        );

        const missing = await app.inject({
            method: 'GET',
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(Buffer.from(missingKeypair.publicKey).toString('base64'))}`,
        });
        const stale = await app.inject({
            method: 'GET',
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(Buffer.from(staleKeypair.publicKey).toString('base64'))}`,
        });

        expect(missing.json()).toEqual({ status: 'not_found', supportsV2: false });
        expect(stale.json()).toEqual(missing.json());
    });

    it.each([
        ['terminal', '/v1/auth/request', '/v1/auth/response', { supportsV2: true }],
        ['account', '/v1/auth/account/request', '/v1/auth/account/response', { version: 3 }],
    ] as const)('expires an approved %s response before redemption', async (kind, requestUrl, responseUrl, extra) => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex').toUpperCase();
        const staleRow = seedPendingPairingRequest(
            kind,
            keypair.publicKey,
            new Date(Date.now() - PAIRING_REQUEST_TTL_MS - 1),
        );
        staleRow.response = Buffer.from('stale-approved-response').toString('base64');
        staleRow.responseAccountId = 'account-1';
        state.repeatKeys.set(`auth-pairing-approval:${kind}:${publicKeyHex}`, {
            key: `auth-pairing-approval:${kind}:${publicKeyHex}`,
            value: 'claimed',
            expiresAt: new Date(Date.now() - 1),
        });

        if (kind === 'terminal') {
            const status = await app.inject({
                method: 'GET',
                url: `/v1/auth/request/status?publicKey=${encodeURIComponent(Buffer.from(keypair.publicKey).toString('base64'))}`,
            });
            expect(status.json()).toEqual({ status: 'not_found', supportsV2: false });
        }

        const redemption = await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: {
                publicKey: Buffer.from(keypair.publicKey).toString('base64'),
                ...extra,
            },
        });

        expect(redemption.statusCode).toBe(200);
        expect(redemption.json()).toEqual({ state: 'requested' });
        const rows = kind === 'terminal' ? state.terminalRequests : state.accountRequests;
        const replacement = rows.get(publicKeyHex);
        expect(replacement?.id).not.toBe(staleRow.id);
        expect(replacement?.response).toBeNull();
        expect(replacement?.responseAccountId).toBeNull();

        const freshApproval = await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey: Buffer.from(keypair.publicKey).toString('base64'),
                response: Buffer.from('fresh-approved-response').toString('base64'),
            },
        });
        expect(freshApproval.statusCode).toBe(200);
    });

    it.each([
        ['terminal', '/v1/auth/response'],
        ['account', '/v1/auth/account/response'],
    ] as const)('fails closed when a fresh %s request expires during approval', async (kind, responseUrl) => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const baseNow = Date.UTC(2026, 6, 13, 12, 0, 0);
        let currentNow = baseNow;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
        const row = seedPendingPairingRequest(
            kind,
            keypair.publicKey,
            new Date(baseNow - PAIRING_REQUEST_TTL_MS + 1),
        );
        const createRepeatKey = dbMock.repeatKey.create.getMockImplementation()!;
        dbMock.repeatKey.create.mockImplementationOnce(async (args: unknown) => {
            const result = await createRepeatKey(args);
            currentNow = baseNow + 2;
            return result;
        });

        const approval = await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey: Buffer.from(keypair.publicKey).toString('base64'),
                response: Buffer.from('opaque-approval').toString('base64'),
            },
        });
        nowSpy.mockRestore();

        expect(approval.statusCode).toBe(404);
        expect(approval.json()).toEqual({ error: 'Request not found' });
        expect(row.response).toBeNull();
    });

    it.each([
        ['terminal', '/v1/auth/request', '/v1/auth/response', { supportsV2: true }],
        ['account', '/v1/auth/account/request', '/v1/auth/account/response', { version: 3 }],
    ] as const)('replaces a stale pending %s request before allowing a fresh approval', async (kind, requestUrl, responseUrl, extra) => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        const staleCreatedAt = new Date(Date.now() - PAIRING_REQUEST_TTL_MS - 1);
        const staleRow = seedPendingPairingRequest(kind, keypair.publicKey, staleCreatedAt);

        const renewed = await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        });

        expect(renewed.statusCode).toBe(200);
        expect(renewed.json()).toEqual({ state: 'requested' });
        const rows = kind === 'terminal' ? state.terminalRequests : state.accountRequests;
        const renewedRow = rows.get(Buffer.from(keypair.publicKey).toString('hex').toUpperCase());
        expect(renewedRow?.id).not.toBe(staleRow.id);
        expect(renewedRow?.createdAt.getTime()).toBeGreaterThan(staleCreatedAt.getTime());

        const approved = await app.inject({
            method: 'POST',
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey,
                response: Buffer.from('fresh-opaque-approval').toString('base64'),
            },
        });
        expect(approved.statusCode).toBe(200);

        const authorized = await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        });
        expect(authorized.json()).toMatchObject({ state: 'authorized' });
        expect(state.tokenCount).toBe(kind === 'terminal' ? 2 : 0);
    });

    it.each([
        ['terminal', '/v1/auth/request', '/v1/auth/response', { supportsV2: true }],
        ['account', '/v1/auth/account/request', '/v1/auth/account/response', { version: 3 }],
    ] as const)('keeps concurrent fresh %s approvals single-use', async (kind, requestUrl, responseUrl, extra) => {
        app = await createApp();
        const keypair = tweetnacl.box.keyPair();
        const publicKey = Buffer.from(keypair.publicKey).toString('base64');
        await app.inject({
            method: 'POST',
            url: requestUrl,
            payload: { publicKey, ...extra },
        });
        const approval = {
            method: 'POST' as const,
            url: responseUrl,
            headers: { 'x-user-id': 'account-1' },
            payload: {
                ...(kind === 'account' ? { version: 3 } : {}),
                publicKey,
                response: Buffer.from('single-use-approval').toString('base64'),
            },
        };

        const responses = await Promise.all([
            app.inject(approval),
            app.inject(approval),
        ]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(state.tokenCount).toBe(kind === 'terminal' ? 2 : 0);
    });
});
