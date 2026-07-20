import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { EncryptedBlobSchema } from "@/app/api/routes/_schemas";
import { randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import { buildAuthChallengeMessage, encodeAuthPairingPayload } from "@northglass/idle-wire";
import type { FastifyReply } from "fastify";
import {
    isPairingRequestFresh,
    pairingRequestCutoff,
    PAIRING_REQUEST_TTL_MS,
} from "@/app/auth/pairingRequestPolicy";
import { RPC_REGISTRATION_CREDENTIAL_PURPOSE } from "@/app/auth/credentialPurpose";
import { admitOrFindAccount } from "@/app/auth/accountAdmission";
import { loadAuthAudience } from "@/app/auth/authAudience";

// Bound + format-validate base64-encoded crypto inputs. Real values are
// short (publicKey 44 chars, signature 88 chars, challenge typically 44-88).
// Cap at 1KB and require base64 charset so SQL injection / template injection
// / oversized garbage gets a 400 from Zod before reaching the handler — never
// a 500 from a downstream decode throw.
const Base64Field = z.string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9+/=]+$/, 'must be base64-encoded');

// Encrypted-response payloads can be larger (variable-size mobile responses).
const Base64Payload = z.string()
    .min(1)
    .max(64 * 1024)
    .regex(/^[A-Za-z0-9+/=]+$/, 'must be base64-encoded');

const AuthChallengeRecordSchema = z.object({
    version: z.literal(3),
    publicKeyHex: z.string().min(1),
    challenge: Base64Field,
}).strict();

const AUTH_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const ACCOUNT_AUTHENTICATION_UNAVAILABLE = 'ACCOUNT_AUTHENTICATION_UNAVAILABLE';
type PrivacyBytes = ReturnType<typeof privacyKit.decodeBase64>;

function decodeBase64(value: string): PrivacyBytes | null {
    try {
        return privacyKit.decodeBase64(value);
    } catch {
        return null;
    }
}

function invalidCredentials(reply: FastifyReply) {
    return reply.code(401).send({ error: 'Invalid credentials' });
}

function pairingRequestNotFound(reply: FastifyReply) {
    return reply.code(404).send({ error: 'Request not found' });
}

function pairingRequestAlreadyApproved(reply: FastifyReply) {
    return reply.code(409).send({ error: 'Pairing request already approved' });
}

function encryptForPairing(publicKey: Uint8Array, payload: Uint8Array): string {
    const ephemeralKeyPair = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(payload, nonce, publicKey, ephemeralKeyPair.secretKey);
    const bundle = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    bundle.set(ephemeralKeyPair.publicKey, 0);
    bundle.set(nonce, ephemeralKeyPair.publicKey.length);
    bundle.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return privacyKit.encodeBase64(bundle);
}

function pairingApprovalKey(scope: 'terminal' | 'account', publicKeyHex: string): string {
    return `auth-pairing-approval:${scope}:${publicKeyHex}`;
}

async function wasPairingApprovalClaimed(
    scope: 'terminal' | 'account',
    publicKeyHex: string,
): Promise<boolean> {
    const claim = await db.repeatKey.findUnique({
        where: { key: pairingApprovalKey(scope, publicKeyHex) },
    });
    return Boolean(
        claim
        && claim.value === 'claimed'
        && claim.expiresAt.getTime() >= Date.now(),
    );
}

async function clearExpiredPairingApprovalClaim(
    scope: 'terminal' | 'account',
    publicKeyHex: string,
): Promise<void> {
    await db.repeatKey.deleteMany({
        where: {
            key: pairingApprovalKey(scope, publicKeyHex),
            value: 'claimed',
            expiresAt: { lt: new Date() },
        },
    });
}

async function claimPairingApproval(
    scope: 'terminal' | 'account',
    publicKeyHex: string,
    requestCreatedAt: Date,
): Promise<boolean> {
    try {
        await db.repeatKey.create({
            data: {
                key: pairingApprovalKey(scope, publicKeyHex),
                value: 'claimed',
                expiresAt: new Date(requestCreatedAt.getTime() + PAIRING_REQUEST_TTL_MS),
            },
        });
        return true;
    } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
            return false;
        }
        throw error;
    }
}

async function createEncryptedPairingResponse(
    publicKey: Uint8Array,
    accountId: string,
    response: string,
    options?: { issueRpcRegistrationCredential?: boolean },
): Promise<string> {
    const token = await auth.createToken(accountId);
    const rpcRegistrationToken = options?.issueRpcRegistrationCredential
        ? await auth.createToken(accountId, {
            credentialPurpose: RPC_REGISTRATION_CREDENTIAL_PURPOSE,
        })
        : undefined;
    return encryptForPairing(publicKey, encodeAuthPairingPayload({
        version: 2,
        token,
        ...(rpcRegistrationToken ? { rpcRegistrationToken } : {}),
        response,
    }));
}

async function getOrRenewTerminalPairingRequest(publicKey: string) {
    const existing = await db.terminalAuthRequest.findUnique({ where: { publicKey } });
    if (existing) {
        if (isPairingRequestFresh(existing.createdAt)) {
            if (!existing.supportsV2) {
                return db.terminalAuthRequest.update({
                    where: { id: existing.id },
                    data: { supportsV2: true },
                });
            }
            return existing;
        }

        const cutoff = pairingRequestCutoff();
        const removed = await db.terminalAuthRequest.deleteMany({
            where: {
                id: existing.id,
                publicKey,
                createdAt: { lt: cutoff },
            },
        });
        if (removed.count === 1) {
            await clearExpiredPairingApprovalClaim('terminal', publicKey);
        }
    }

    // Upsert handles concurrent first requests and concurrent renewal attempts.
    return db.terminalAuthRequest.upsert({
        where: { publicKey },
        update: { supportsV2: true },
        create: { publicKey, supportsV2: true },
    });
}

async function getOrRenewAccountPairingRequest(publicKey: string) {
    const existing = await db.accountAuthRequest.findUnique({ where: { publicKey } });
    if (existing) {
        if (isPairingRequestFresh(existing.createdAt)) {
            return existing;
        }

        const cutoff = pairingRequestCutoff();
        const removed = await db.accountAuthRequest.deleteMany({
            where: {
                id: existing.id,
                publicKey,
                createdAt: { lt: cutoff },
            },
        });
        if (removed.count === 1) {
            await clearExpiredPairingApprovalClaim('account', publicKey);
        }
    }

    return db.accountAuthRequest.upsert({
        where: { publicKey },
        update: {},
        create: { publicKey },
    });
}

export function authRoutes(app: Fastify) {
    const authAudience = loadAuthAudience();

    app.post('/v1/auth/challenge', {
        config: {
            rateLimit: { max: 10, timeWindow: '1 minute' },
        },
        schema: {
            body: z.object({
                version: z.literal(3),
                publicKey: Base64Field,
            }).strict(),
            response: {
                200: z.object({
                    version: z.literal(3),
                    challengeId: z.string().uuid(),
                    challenge: Base64Field,
                }),
                401: z.object({ error: z.literal('Invalid credentials') }),
            },
        },
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        if (!publicKey || publicKey.length !== tweetnacl.sign.publicKeyLength) {
            return invalidCredentials(reply);
        }

        const challengeId = randomUUID();
        const challenge = privacyKit.encodeBase64(new Uint8Array(tweetnacl.randomBytes(32)));
        await db.repeatKey.create({
            data: {
                key: `auth-challenge:${challengeId}`,
                value: JSON.stringify({
                    version: 3,
                    publicKeyHex: privacyKit.encodeHex(publicKey),
                    challenge,
                }),
                expiresAt: new Date(Date.now() + AUTH_CHALLENGE_TTL_MS),
            },
        });
        return reply.send({ version: 3 as const, challengeId, challenge });
    });

    app.post('/v1/auth', {
        schema: {
            body: z.object({
                version: z.literal(3),
                publicKey: Base64Field,
                challengeId: z.string().uuid(),
                signature: Base64Field
            }).strict()
        }
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        const signature = decodeBase64(request.body.signature);
        if (!publicKey || !signature || publicKey.length !== tweetnacl.sign.publicKeyLength || signature.length !== tweetnacl.sign.signatureLength) {
            return invalidCredentials(reply);
        }

        const challengeKey = `auth-challenge:${request.body.challengeId}`;
        const challengeRow = await db.repeatKey.findUnique({ where: { key: challengeKey } });
        if (!challengeRow || challengeRow.expiresAt < new Date()) {
            return invalidCredentials(reply);
        }
        let storedChallenge: unknown;
        try {
            storedChallenge = JSON.parse(challengeRow.value);
        } catch {
            return invalidCredentials(reply);
        }
        const parsed = AuthChallengeRecordSchema.safeParse(storedChallenge);
        if (!parsed.success || parsed.data.publicKeyHex !== privacyKit.encodeHex(publicKey)) {
            return invalidCredentials(reply);
        }
        const message = buildAuthChallengeMessage(
            authAudience,
            request.body.challengeId,
            parsed.data.challenge,
        );
        if (!tweetnacl.sign.detached.verify(message, signature, publicKey)) {
            return invalidCredentials(reply);
        }

        const consumed = await db.repeatKey.deleteMany({
            where: {
                key: challengeKey,
                value: challengeRow.value,
                expiresAt: { gte: new Date() },
            },
        });
        if (consumed.count !== 1) {
            return invalidCredentials(reply);
        }

        // Proof of key possession authenticates an existing account. Unknown
        // keys additionally pass the deployment's durable admission policy;
        // changing public keys cannot mint unlimited quota principals.
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const admission = await admitOrFindAccount(publicKeyHex);
        if (admission.kind === 'denied') {
            return invalidCredentials(reply);
        }
        const user = admission.account;
        if (user.authSuspendedAt != null) {
            return invalidCredentials(reply);
        }

        let token: string;
        try {
            // createToken repeats the authoritative suspension check to close a
            // race with an operator action after the upsert above.
            token = await auth.createToken(user.id);
        } catch (error) {
            if ((error as { code?: unknown })?.code === ACCOUNT_AUTHENTICATION_UNAVAILABLE) {
                return invalidCredentials(reply);
            }
            throw error;
        }

        return reply.send({
            success: true,
            token,
        });
    });

    // Bound unauthenticated request-row creation. Expiry cleanup provides a
    // second limit on retained rows.
    app.post('/v1/auth/request', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: z.object({
                publicKey: Base64Field,
                supportsV2: z.literal(true)
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    response: EncryptedBlobSchema
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-request' }, 'Terminal authentication request received');

        const answer = await getOrRenewTerminalPairingRequest(publicKeyHex);

        if (answer.response && answer.responseAccountId) {
            const consumed = await db.terminalAuthRequest.deleteMany({
                where: {
                    id: answer.id,
                    response: { not: null },
                    responseAccountId: { not: null },
                    createdAt: { gte: pairingRequestCutoff() },
                },
            });
            if (consumed.count !== 1) {
                return reply.send({ state: 'requested' });
            }
            return reply.send({
                state: 'authorized',
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status.
    //
    // Rate-limit status probes to 30/min/IP. Without a cap, an attacker
    // could probe whether a given publicKey is in the
    // pairing pipeline (`not_found` vs `pending` vs `authorized`). The
    // publicKey itself is a 32-byte random value (~10^77 search space —
    // unguessable in practice), so the leak is mostly theoretical, but a
    // generous rate cap closes the brute-force probe vector cheaply.
    app.get('/v1/auth/request/status', {
        config: {
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
            },
        },
        schema: {
            querystring: z.object({
                publicKey: Base64Field,
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.query.publicKey);
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest || !isPairingRequestFresh(authRequest.createdAt)) {
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: true });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: Base64Payload,
                publicKey: Base64Field
            })
        }
    }, async (request, reply) => {
        log({ module: 'auth-response' }, 'Terminal authentication approval received');
        const publicKey = decodeBase64(request.body.publicKey);
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            if (await wasPairingApprovalClaimed('terminal', publicKeyHex)) {
                return pairingRequestAlreadyApproved(reply);
            }
            return pairingRequestNotFound(reply);
        }
        if (!isPairingRequestFresh(authRequest.createdAt)) {
            return pairingRequestNotFound(reply);
        }
        if (authRequest.response) {
            return pairingRequestAlreadyApproved(reply);
        }
        const claimed = await claimPairingApproval('terminal', publicKeyHex, authRequest.createdAt);
        if (!claimed) {
            return pairingRequestAlreadyApproved(reply);
        }
        const response = await createEncryptedPairingResponse(
            publicKey,
            request.userId,
            request.body.response,
            { issueRpcRegistrationCredential: true },
        );
        const stored = await db.terminalAuthRequest.updateMany({
            where: {
                id: authRequest.id,
                response: null,
                createdAt: { gte: pairingRequestCutoff() },
            },
            data: { response, responseAccountId: request.userId }
        });
        if (stored.count !== 1) {
            return pairingRequestNotFound(reply);
        }
        return reply.send({ success: true });
    });

    // Account auth request
    app.post('/v1/auth/account/request', {
        config: {
            // Account restore is a long-polling, unauthenticated surface. Keep
            // its budget separate so an abandoned restore tab cannot starve
            // authenticated session sync for every client behind the same NAT.
            rateLimit: {
                max: 30,
                timeWindow: '1 minute',
                groupId: 'account-pairing-request',
            },
        },
        schema: {
            body: z.object({
                version: z.literal(3),
                publicKey: Base64Field,
            }).strict(),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    response: EncryptedBlobSchema
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await getOrRenewAccountPairingRequest(privacyKit.encodeHex(publicKey));

        if (answer.response && answer.responseAccountId) {
            const consumed = await db.accountAuthRequest.deleteMany({
                where: {
                    id: answer.id,
                    response: { not: null },
                    responseAccountId: { not: null },
                    createdAt: { gte: pairingRequestCutoff() },
                },
            });
            if (consumed.count !== 1) {
                return reply.send({ state: 'requested' });
            }
            return reply.send({
                state: 'authorized',
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                version: z.literal(3),
                response: Base64Payload,
                publicKey: Base64Field
            }).strict()
        }
    }, async (request, reply) => {
        const publicKey = decodeBase64(request.body.publicKey);
        if (!publicKey || tweetnacl.box.publicKeyLength !== publicKey.length) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }
        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });
        if (!authRequest) {
            if (await wasPairingApprovalClaimed('account', publicKeyHex)) {
                return pairingRequestAlreadyApproved(reply);
            }
            return pairingRequestNotFound(reply);
        }
        if (!isPairingRequestFresh(authRequest.createdAt)) {
            return pairingRequestNotFound(reply);
        }
        if (authRequest.response) {
            return pairingRequestAlreadyApproved(reply);
        }
        const claimed = await claimPairingApproval('account', publicKeyHex, authRequest.createdAt);
        if (!claimed) {
            return pairingRequestAlreadyApproved(reply);
        }
        const stored = await db.accountAuthRequest.updateMany({
            where: {
                id: authRequest.id,
                response: null,
                createdAt: { gte: pairingRequestCutoff() },
            },
            data: { response: request.body.response, responseAccountId: request.userId }
        });
        if (stored.count !== 1) {
            return pairingRequestNotFound(reply);
        }
        return reply.send({ success: true });
    });

}
