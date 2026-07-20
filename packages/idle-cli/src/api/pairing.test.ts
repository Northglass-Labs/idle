import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeAuthPairingPayload } from '@northglass/idle-wire';

import { encodeBase64 } from './encryption';
import {
    decryptPairingCredentials,
    usesLegacyTokenOutsidePairingEnvelope,
} from './pairing';

function encryptBox(data: Uint8Array, publicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const encrypted = tweetnacl.box(data, nonce, publicKey, ephemeral.secretKey);
    const bundle = new Uint8Array(32 + nonce.length + encrypted.length);
    bundle.set(ephemeral.publicKey);
    bundle.set(nonce, 32);
    bundle.set(encrypted, 32 + nonce.length);
    return bundle;
}

describe('decryptPairingCredentials', () => {
    it('requires possession of the private key and unwraps token plus response', () => {
        const keypair = tweetnacl.box.keyPair();
        const secret = tweetnacl.randomBytes(32);
        const inner = encryptBox(secret, keypair.publicKey);
        const outer = encryptBox(encodeAuthPairingPayload({
            version: 2,
            token: 'token-value',
            rpcRegistrationToken: 'rpc-registration-token',
            response: encodeBase64(inner),
        }), keypair.publicKey);

        expect(decryptPairingCredentials(encodeBase64(outer), keypair.secretKey)).toEqual({
            token: 'token-value',
            rpcRegistrationToken: 'rpc-registration-token',
            response: secret,
        });
        expect(decryptPairingCredentials(
            encodeBase64(outer),
            tweetnacl.box.keyPair().secretKey,
        )).toBeNull();
    });

    it('rejects a legacy plaintext-token response shape', () => {
        const keypair = tweetnacl.box.keyPair();
        const legacy = encryptBox(tweetnacl.randomBytes(32), keypair.publicKey);
        expect(decryptPairingCredentials(encodeBase64(legacy), keypair.secretKey)).toBeNull();
    });
});

describe('usesLegacyTokenOutsidePairingEnvelope', () => {
    it('detects the obsolete relay response without inspecting or returning credentials', () => {
        expect(usesLegacyTokenOutsidePairingEnvelope({
            state: 'authorized',
            token: 'do-not-log-this-token',
            response: 'opaque-ciphertext',
        })).toBe(true);
        expect(usesLegacyTokenOutsidePairingEnvelope({
            state: 'authorized',
            response: 'encrypted-v2-envelope',
        })).toBe(false);
        expect(usesLegacyTokenOutsidePairingEnvelope(null)).toBe(false);
    });
});
