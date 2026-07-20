import tweetnacl from 'tweetnacl';
import { decodeAuthPairingPayload } from '@northglass/idle-wire';

import { decodeBase64 } from './encryption';

/**
 * Identify the pre-v2 relay shape without accepting or exposing its plaintext
 * bearer token. Hardened clients require the token inside the encrypted outer
 * pairing envelope.
 */
export function usesLegacyTokenOutsidePairingEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.token === 'string' && typeof record.response === 'string';
}

function decryptBoxBundle(bundle: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength + tweetnacl.box.overheadLength) {
        return null;
    }
    const publicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
    const nonceStart = tweetnacl.box.publicKeyLength;
    const nonce = bundle.slice(nonceStart, nonceStart + tweetnacl.box.nonceLength);
    const ciphertext = bundle.slice(nonceStart + tweetnacl.box.nonceLength);
    const decrypted = tweetnacl.box.open(ciphertext, nonce, publicKey, secretKey);
    return decrypted ? new Uint8Array(decrypted) : null;
}

export function decryptPairingCredentials(
    encryptedResponseBase64: string,
    secretKey: Uint8Array,
): { token: string; rpcRegistrationToken?: string; response: Uint8Array } | null {
    const outer = decryptBoxBundle(decodeBase64(encryptedResponseBase64), secretKey);
    if (!outer) return null;

    const payload = decodeAuthPairingPayload(outer);
    if (!payload) return null;

    const response = decryptBoxBundle(decodeBase64(payload.response), secretKey);
    return response ? {
        token: payload.token,
        ...(payload.rpcRegistrationToken
            ? { rpcRegistrationToken: payload.rpcRegistrationToken }
            : {}),
        response,
    } : null;
}
