import { z } from 'zod';
import { normalizeServerUrl } from './serverUrlPolicy';

const Base64PayloadSchema = z.string()
    .min(1)
    .max(64 * 1024)
    .regex(/^[A-Za-z0-9+/=]+$/);

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const Canonical32ByteBase64Schema = z.string()
    .length(44)
    .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be canonical base64 for exactly 32 bytes')
    .refine((value) => BASE64_ALPHABET.indexOf(value[42]) % 4 === 0, {
        message: 'must use canonical base64 padding bits',
    });

const Canonical64ByteBase64Schema = z.string()
    .length(88)
    .regex(/^[A-Za-z0-9+/]{86}==$/, 'must be canonical base64 for exactly 64 bytes')
    .refine((value) => BASE64_ALPHABET.indexOf(value[85]) % 16 === 0, {
        message: 'must use canonical base64 padding bits',
    });

const BearerTokenSchema = z.string()
    .min(1)
    .max(16 * 1024)
    .regex(/^[^\u0000-\u0020\u007f]+$/, 'must not contain whitespace or control characters');

export const AuthPairingPayloadSchema = z.object({
    version: z.literal(2),
    token: z.string().min(1).max(16 * 1024),
    rpcRegistrationToken: z.string().min(1).max(16 * 1024).optional(),
    response: Base64PayloadSchema,
}).strict();

export type AuthPairingPayload = z.infer<typeof AuthPairingPayloadSchema>;

export const AccountPairingUnsignedPayloadSchema = z.object({
    type: z.literal('idle-account-pairing'),
    version: z.literal(3),
    relayAudience: z.string().min(1).max(2048),
    requesterPublicKey: Canonical32ByteBase64Schema,
    accountPublicKey: Canonical32ByteBase64Schema,
    token: BearerTokenSchema,
    secret: Canonical32ByteBase64Schema,
}).strict();

export const AccountPairingPayloadSchema = AccountPairingUnsignedPayloadSchema.extend({
    signature: Canonical64ByteBase64Schema,
}).strict();

export type AccountPairingUnsignedPayload = z.infer<typeof AccountPairingUnsignedPayloadSchema>;
export type AccountPairingPayload = z.infer<typeof AccountPairingPayloadSchema>;

function normalizeAccountPairingUnsignedPayload(
    payload: AccountPairingUnsignedPayload,
): AccountPairingUnsignedPayload {
    const parsed = AccountPairingUnsignedPayloadSchema.parse(payload);
    return {
        ...parsed,
        relayAudience: normalizeServerUrl(parsed.relayAudience),
    };
}

export function buildAuthChallengeMessage(
    audience: string,
    challengeId: string,
    challengeBase64: string,
): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
        type: 'idle-auth',
        version: 3,
        audience: normalizeServerUrl(audience),
        challengeId,
        challenge: challengeBase64,
    }));
}

export function buildAccountPairingMessage(
    payload: AccountPairingUnsignedPayload,
): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(
        normalizeAccountPairingUnsignedPayload(payload),
    ));
}

export function encodeAccountPairingPayload(payload: AccountPairingPayload): Uint8Array {
    const parsed = AccountPairingPayloadSchema.parse(payload);
    const { signature, ...unsigned } = parsed;
    return new TextEncoder().encode(JSON.stringify({
        ...normalizeAccountPairingUnsignedPayload(unsigned),
        signature,
    }));
}

export function decodeAccountPairingPayload(payload: Uint8Array): AccountPairingPayload | null {
    try {
        const parsed = AccountPairingPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
        if (normalizeServerUrl(parsed.relayAudience) !== parsed.relayAudience) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function formatAccountPairingCode(signature: Uint8Array): string {
    if (!(signature instanceof Uint8Array) || signature.length < 6) {
        throw new Error('Account pairing signature must contain at least six bytes');
    }
    const compact = Array.from(signature.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

export function encodeAuthPairingPayload(payload: AuthPairingPayload): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(AuthPairingPayloadSchema.parse(payload)));
}

export function decodeAuthPairingPayload(payload: Uint8Array): AuthPairingPayload | null {
    try {
        return AuthPairingPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
    } catch {
        return null;
    }
}
