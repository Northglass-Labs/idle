import {
    buildAccountPairingMessage,
    decodeAccountPairingPayload,
    decodeAuthPairingPayload,
    encodeAccountPairingPayload,
    formatAccountPairingCode,
    normalizeServerUrl,
} from '@northglass/idle-wire';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox, encryptBox } from '@/encryption/libsodium';
import sodium from '@/encryption/libsodium.lib';

export type AccountPairingApproval = {
    response: Uint8Array;
    verificationCode: string;
};

export type AccountPairingCredentials = {
    token: string;
    secret: Uint8Array;
    accountPublicKey: Uint8Array;
    verificationCode: string;
};

export function createAccountPairingApproval(input: {
    relayAudience: string;
    requesterPublicKey: Uint8Array;
    accountSecret: Uint8Array;
    token: string;
}): AccountPairingApproval {
    if (input.requesterPublicKey.length !== 32) {
        throw new Error('Account pairing requester key must be exactly 32 bytes');
    }
    if (input.accountSecret.length !== 32) {
        throw new Error('Account pairing secret must be exactly 32 bytes');
    }

    const accountKeyPair = sodium.crypto_sign_seed_keypair(input.accountSecret);
    const unsigned = {
        type: 'idle-account-pairing' as const,
        version: 3 as const,
        relayAudience: normalizeServerUrl(input.relayAudience),
        requesterPublicKey: encodeBase64(input.requesterPublicKey),
        accountPublicKey: encodeBase64(accountKeyPair.publicKey),
        token: input.token,
        secret: encodeBase64(input.accountSecret),
    };
    const signature = sodium.crypto_sign_detached(
        buildAccountPairingMessage(unsigned),
        accountKeyPair.privateKey,
    );
    const response = encryptBox(encodeAccountPairingPayload({
        ...unsigned,
        signature: encodeBase64(signature),
    }), input.requesterPublicKey);

    return {
        response,
        verificationCode: formatAccountPairingCode(signature),
    };
}

export function decryptAccountPairingCredentials(
    encryptedResponseBase64: string,
    requesterSecretKey: Uint8Array,
    relayAudience: string,
    requesterPublicKey: Uint8Array,
): AccountPairingCredentials | null {
    try {
        const cleartext = decryptBox(decodeBase64(encryptedResponseBase64), requesterSecretKey);
        if (!cleartext) return null;

        const payload = decodeAccountPairingPayload(cleartext);
        if (!payload) return null;
        if (payload.relayAudience !== normalizeServerUrl(relayAudience)) return null;
        if (payload.requesterPublicKey !== encodeBase64(requesterPublicKey)) return null;

        const secret = decodeBase64(payload.secret);
        const accountPublicKey = decodeBase64(payload.accountPublicKey);
        const signature = decodeBase64(payload.signature);
        const derivedAccountPublicKey = sodium.crypto_sign_seed_keypair(secret).publicKey;
        if (encodeBase64(derivedAccountPublicKey) !== payload.accountPublicKey) return null;

        const { signature: _signature, ...unsigned } = payload;
        if (!sodium.crypto_sign_verify_detached(
            signature,
            buildAccountPairingMessage(unsigned),
            accountPublicKey,
        )) return null;

        return {
            token: payload.token,
            secret,
            accountPublicKey,
            verificationCode: formatAccountPairingCode(signature),
        };
    } catch {
        return null;
    }
}

export function decryptPairingCredentials(
    encryptedResponseBase64: string,
    secretKey: Uint8Array,
): { token: string; secret: Uint8Array } | null {
    const outer = decryptBox(decodeBase64(encryptedResponseBase64), secretKey);
    if (!outer) return null;

    const payload = decodeAuthPairingPayload(outer);
    if (!payload) return null;

    const secret = decryptBox(decodeBase64(payload.response), secretKey);
    return secret ? { token: payload.token, secret } : null;
}
