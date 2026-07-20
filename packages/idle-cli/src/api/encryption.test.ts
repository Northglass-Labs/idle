import { describe, it, expect } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    decryptBlob,
    encodeBase64,
    decodeBase64,
    getRandomBytes,
    encryptWithDataKey,
    decryptWithDataKey,
    encryptLegacy,
    decryptLegacy,
    encrypt,
    decrypt,
    libsodiumEncryptForPublicKey,
    signAuthChallenge,
} from './encryption';
import { buildAuthChallengeMessage } from '@northglass/idle-wire';

describe('AES-256-GCM (dataKey variant)', () => {
    it('round-trip encrypt/decrypt', () => {
        const key = getRandomBytes(32);
        const data = { hello: 'world', nested: { arr: [1, 2, 3] } };
        const encrypted = encryptWithDataKey(data, key);
        const decrypted = decryptWithDataKey(encrypted, key);
        expect(decrypted).toEqual(data);
    });

    it('produces different ciphertext on each call (random nonce)', () => {
        const key = getRandomBytes(32);
        const data = 'same plaintext';
        const a = encryptWithDataKey(data, key);
        const b = encryptWithDataKey(data, key);
        // Bundles should differ because nonces are random
        expect(a).not.toEqual(b);
    });

    it('encrypted bundle starts with version byte 0', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        expect(encrypted[0]).toBe(0);
    });

    it('bundle has minimum length: 1 (version) + 12 (nonce) + 16 (auth tag) = 29', () => {
        const key = getRandomBytes(32);
        // Even an empty-ish JSON value like `null` produces some ciphertext
        const encrypted = encryptWithDataKey(null, key);
        // version(1) + nonce(12) + ciphertext(>=1) + authTag(16) >= 30
        expect(encrypted.length).toBeGreaterThanOrEqual(29);
    });

    it('decryption returns null with wrong key', () => {
        const key1 = getRandomBytes(32);
        const key2 = getRandomBytes(32);
        const encrypted = encryptWithDataKey('secret', key1);
        expect(decryptWithDataKey(encrypted, key2)).toBeNull();
    });

    it('decryption returns null for tampered data', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        // Flip a byte in the ciphertext region (after version + nonce)
        encrypted[20] ^= 0xff;
        expect(decryptWithDataKey(encrypted, key)).toBeNull();
    });

    it('decryption returns null for truncated bundle', () => {
        const key = getRandomBytes(32);
        // Too short to contain version + nonce + auth tag
        expect(decryptWithDataKey(new Uint8Array(10), key)).toBeNull();
        // Exactly at boundary: version(1) + nonce(12) + authTag(16) - 1
        expect(decryptWithDataKey(new Uint8Array(28), key)).toBeNull();
    });

    it('decryption returns null for wrong version byte', () => {
        const key = getRandomBytes(32);
        const encrypted = encryptWithDataKey('test', key);
        encrypted[0] = 1; // unsupported version
        expect(decryptWithDataKey(encrypted, key)).toBeNull();
    });

    it('decryption returns null for empty bundle', () => {
        const key = getRandomBytes(32);
        expect(decryptWithDataKey(new Uint8Array(0), key)).toBeNull();
    });
});

describe('legacy TweetNaCl SecretBox', () => {
    it('round-trip with JSON object', () => {
        const secret = getRandomBytes(32);
        const data = { message: 'hello', items: [1, 2, 3] };
        const encrypted = encryptLegacy(data, secret);
        const decrypted = decryptLegacy(encrypted, secret);
        expect(decrypted).toEqual(data);
    });

    it('round-trip with string', () => {
        const secret = getRandomBytes(32);
        const data = 'hello world';
        const encrypted = encryptLegacy(data, secret);
        const decrypted = decryptLegacy(encrypted, secret);
        expect(decrypted).toBe('hello world');
    });

    it('decryption returns null with wrong key', () => {
        const secret1 = getRandomBytes(32);
        const secret2 = getRandomBytes(32);
        const encrypted = encryptLegacy('test', secret1);
        expect(decryptLegacy(encrypted, secret2)).toBeNull();
    });

    it('bundle is longer than 24 bytes (nonce prefix)', () => {
        const secret = getRandomBytes(32);
        const encrypted = encryptLegacy('x', secret);
        // 24-byte nonce + at least some ciphertext
        expect(encrypted.length).toBeGreaterThan(24);
    });
});

describe('encrypt/decrypt dispatcher', () => {
    it('dataKey variant round-trip', () => {
        const key = getRandomBytes(32);
        const data = { test: true };
        const encrypted = encrypt(key, 'dataKey', data);
        // Should have AES-GCM version byte
        expect(encrypted[0]).toBe(0);
        expect(decrypt(key, 'dataKey', encrypted)).toEqual(data);
    });

    it('legacy variant round-trip', () => {
        const key = getRandomBytes(32);
        const data = { test: true };
        const encrypted = encrypt(key, 'legacy', data);
        expect(decrypt(key, 'legacy', encrypted)).toEqual(data);
    });

    it('cross-variant decrypt fails', () => {
        const key = getRandomBytes(32);
        // Encrypt with dataKey, try to decrypt with legacy
        const encryptedDataKey = encrypt(key, 'dataKey', 'test');
        expect(decrypt(key, 'legacy', encryptedDataKey)).toBeNull();
    });
});

describe('libsodiumEncryptForPublicKey (box encryption)', () => {
    it('round-trip with matching keypair', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);

        // Manually decrypt: extract ephemeral pubkey (32), nonce (24), ciphertext
        const ephemeralPubKey = encrypted.slice(0, 32);
        const nonce = encrypted.slice(32, 56);
        const ciphertext = encrypted.slice(56);
        const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPubKey, recipientKeyPair.secretKey);

        expect(decrypted).toEqual(data);
    });

    it('bundle has expected structure (32 pubkey + 24 nonce + ciphertext)', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);
        // 32 (ephemeral pubkey) + 24 (nonce) + ciphertext (data.length + 16 MAC)
        expect(encrypted.length).toBe(32 + 24 + data.length + tweetnacl.box.overheadLength);
    });

    it('decryption fails with wrong secret key', () => {
        const recipientKeyPair = tweetnacl.box.keyPair();
        const wrongKeyPair = tweetnacl.box.keyPair();
        const data = new Uint8Array([1, 2, 3]);
        const encrypted = libsodiumEncryptForPublicKey(data, recipientKeyPair.publicKey);

        const ephemeralPubKey = encrypted.slice(0, 32);
        const nonce = encrypted.slice(32, 56);
        const ciphertext = encrypted.slice(56);
        const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPubKey, wrongKeyPair.secretKey);

        expect(decrypted).toBeNull();
    });
});

describe('signAuthChallenge', () => {
    const audience = 'https://relay.example.test';
    const challengeId = '123e4567-e89b-12d3-a456-426614174000';
    const challenge = 'AQIDBA==';

    it('signs the audience-bound server challenge', () => {
        const secret = getRandomBytes(32);
        const result = signAuthChallenge(secret, audience, challengeId, challenge);

        expect(result.publicKey.length).toBe(32);
        expect(result.signature.length).toBe(64);

        const valid = tweetnacl.sign.detached.verify(
            buildAuthChallengeMessage(audience, challengeId, challenge),
            result.signature,
            result.publicKey,
        );
        expect(valid).toBe(true);
    });

    it('verification fails with wrong public key', () => {
        const secret1 = getRandomBytes(32);
        const secret2 = getRandomBytes(32);
        const result1 = signAuthChallenge(secret1, audience, challengeId, challenge);
        const result2 = signAuthChallenge(secret2, audience, challengeId, challenge);

        const valid = tweetnacl.sign.detached.verify(
            buildAuthChallengeMessage(audience, challengeId, challenge),
            result1.signature,
            result2.publicKey,
        );
        expect(valid).toBe(false);
    });

    it('binds the signature to the challenge id', () => {
        const secret = getRandomBytes(32);
        const result = signAuthChallenge(secret, audience, challengeId, challenge);
        expect(tweetnacl.sign.detached.verify(
            buildAuthChallengeMessage(
                audience,
                '223e4567-e89b-12d3-a456-426614174000',
                challenge,
            ),
            result.signature,
            result.publicKey,
        )).toBe(false);
    });

    it('does not verify at another relay audience', () => {
        const secret = getRandomBytes(32);
        const result = signAuthChallenge(secret, audience, challengeId, challenge);

        expect(tweetnacl.sign.detached.verify(
            buildAuthChallengeMessage('https://other.example.test', challengeId, challenge),
            result.signature,
            result.publicKey,
        )).toBe(false);
    });
});

describe('base64 encoding', () => {
    it('round-trip with binary data', () => {
        const data = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const encoded = encodeBase64(data);
        const decoded = decodeBase64(encoded);
        expect(decoded).toEqual(data);
    });

    it('round-trip with empty buffer', () => {
        const data = new Uint8Array([]);
        const encoded = encodeBase64(data);
        expect(encoded).toBe('');
        expect(decodeBase64('')).toEqual(data);
    });

    it('base64url round-trip', () => {
        // Use bytes that produce + and / in standard base64
        const data = new Uint8Array([251, 239, 190]);
        const encoded = encodeBase64(data, 'base64url');
        expect(encoded).not.toMatch(/[+/=]/);
        const decoded = decodeBase64(encoded, 'base64url');
        expect(decoded).toEqual(data);
    });
});

describe('decryptBlob', () => {
    it('decrypts a blob encrypted with NaCl secretbox', () => {
        const key = getRandomBytes(32);
        const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        // Wire format: nonce + ciphertext
        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        const decrypted = decryptBlob(bundle, key);
        expect(decrypted).not.toBeNull();
        expect(decrypted).toEqual(plaintext);
    });

    it('returns null for wrong key', () => {
        const key = getRandomBytes(32);
        const wrongKey = getRandomBytes(32);
        const plaintext = new Uint8Array([10, 20, 30]);
        const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
        const ciphertext = tweetnacl.secretbox(plaintext, nonce, key);

        const bundle = new Uint8Array(nonce.length + ciphertext.length);
        bundle.set(nonce, 0);
        bundle.set(ciphertext, nonce.length);

        expect(decryptBlob(bundle, wrongKey)).toBeNull();
    });

    it('returns null for truncated bundle', () => {
        const key = getRandomBytes(32);
        const tooShort = new Uint8Array(10); // Less than nonce (24) + auth tag (16)
        expect(decryptBlob(tooShort, key)).toBeNull();
    });

    it('round-trips binary data of various sizes', () => {
        const key = getRandomBytes(32);
        for (const size of [0, 1, 255, 1024, 65536]) {
            const data = getRandomBytes(size);
            const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
            const encrypted = tweetnacl.secretbox(data, nonce, key);
            const bundle = new Uint8Array(nonce.length + encrypted.length);
            bundle.set(nonce, 0);
            bundle.set(encrypted, nonce.length);

            const decrypted = decryptBlob(bundle, key);
            expect(decrypted).toEqual(data);
        }
    });
});
