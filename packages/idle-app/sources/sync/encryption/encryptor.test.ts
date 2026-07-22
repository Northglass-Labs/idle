import { beforeAll, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';

vi.mock('expo-crypto', () => ({
    getRandomBytes: (size: number) => new Uint8Array(require('node:crypto').randomBytes(size)),
}));
vi.mock('@/encryption/libsodium.lib', async () => {
    const { default: sodium } = await import('libsodium-wrappers');
    await sodium.ready;
    return { default: sodium };
});
// Native AES is exercised through adapter tests in aes.test.ts. The encryptor
// contract can run headlessly against the wire-compatible Web Crypto backend.
vi.mock('@/encryption/aes', async () => await import('@/encryption/aes.web'));

import { getRandomBytes } from 'expo-crypto';
import { AES256Encryption, BoxEncryption, SecretBoxEncryption } from './encryptor';

beforeAll(async () => {
    await sodium.ready;
});

describe('SecretBoxEncryption', () => {
    it('round-trips a JSON object', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const original = { message: 'Hello, World!', sequence: 1 };

        const decrypted = await encryptor.decrypt(await encryptor.encrypt([original]));

        expect(decrypted).toEqual([original]);
    });

    it('round-trips a heterogeneous batch', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const original = ['first', { message: 'second' }, [1, 2, 3]];

        const decrypted = await encryptor.decrypt(await encryptor.encrypt(original));

        expect(decrypted).toEqual(original);
    });

    it('handles an empty batch', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));

        expect(await encryptor.encrypt([])).toEqual([]);
        expect(await encryptor.decrypt([])).toEqual([]);
    });

    it('uses a fresh nonce for every encryption', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const original = { message: 'same' };
        const first = await encryptor.encrypt([original]);
        const second = await encryptor.encrypt([original]);

        expect(first[0]).not.toEqual(second[0]);
        expect(await encryptor.decrypt(first)).toEqual([original]);
        expect(await encryptor.decrypt(second)).toEqual([original]);
    });

    it('rejects ciphertext encrypted under another key', async () => {
        const first = new SecretBoxEncryption(getRandomBytes(32));
        const second = new SecretBoxEncryption(getRandomBytes(32));
        const encrypted = await first.encrypt([{ secret: true }]);

        expect(await second.decrypt(encrypted)).toEqual([null]);
    });

    it('rejects tampered ciphertext', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const [encrypted] = await encryptor.encrypt([{ authenticated: true }]);
        const tampered = new Uint8Array(encrypted);
        tampered[tampered.length - 1] ^= 0xff;

        expect(await encryptor.decrypt([tampered])).toEqual([null]);
    });

    it('round-trips a moderate payload', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const original = { values: Array.from({ length: 10 * 1024 }, (_, index) => index % 256) };

        expect(await encryptor.decrypt(await encryptor.encrypt([original]))).toEqual([original]);
    });

    it('round-trips 500 independently encrypted items', async () => {
        const encryptor = new SecretBoxEncryption(getRandomBytes(32));
        const original = Array.from({ length: 500 }, (_, index) => ({ index, message: `item-${index}` }));

        const encrypted = await Promise.all(original.map(async (item) => (await encryptor.encrypt([item]))[0]));
        const decrypted = await Promise.all(encrypted.map(async (item) => (await encryptor.decrypt([item]))[0]));

        expect(decrypted).toEqual(original);
    });
});

describe('BoxEncryption', () => {
    it('round-trips a JSON object', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = { message: 'Hello, Box!', sequence: 1 };

        expect(await encryptor.decrypt(await encryptor.encrypt([original]))).toEqual([original]);
    });

    it('round-trips a heterogeneous batch', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = ['first', { message: 'second' }, [1, 2, 3]];

        expect(await encryptor.decrypt(await encryptor.encrypt(original))).toEqual(original);
    });

    it('handles an empty batch', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));

        expect(await encryptor.encrypt([])).toEqual([]);
        expect(await encryptor.decrypt([])).toEqual([]);
    });

    it('derives a stable recipient key from the same seed', async () => {
        const seed = getRandomBytes(32);
        const first = new BoxEncryption(seed);
        const second = new BoxEncryption(seed);
        const original = { message: 'consistent' };

        expect(await second.decrypt(await first.encrypt([original]))).toEqual([original]);
    });

    it('uses a fresh ephemeral key for every encryption', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = { message: 'same' };
        const first = await encryptor.encrypt([original]);
        const second = await encryptor.encrypt([original]);

        expect(first[0]).not.toEqual(second[0]);
        expect(await encryptor.decrypt(first)).toEqual([original]);
        expect(await encryptor.decrypt(second)).toEqual([original]);
    });

    it('rejects ciphertext addressed to another key', async () => {
        const first = new BoxEncryption(getRandomBytes(32));
        const second = new BoxEncryption(getRandomBytes(32));
        const encrypted = await first.encrypt([{ secret: true }]);

        expect(await second.decrypt(encrypted)).toEqual([null]);
    });

    it('rejects tampered ciphertext', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const [encrypted] = await encryptor.encrypt([{ authenticated: true }]);
        const tampered = new Uint8Array(encrypted);
        tampered[tampered.length - 1] ^= 0xff;

        expect(await encryptor.decrypt([tampered])).toEqual([null]);
    });

    it('round-trips a moderate payload', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = { values: Array.from({ length: 10 * 1024 }, (_, index) => (index * 3) % 256) };

        expect(await encryptor.decrypt(await encryptor.encrypt([original]))).toEqual([original]);
    });

    it('round-trips mixed payload sizes in one batch', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = [
            'small',
            { values: Array.from({ length: 512 }, (_, index) => index % 256) },
            { text: 'x'.repeat(5 * 1024) },
        ];

        expect(await encryptor.decrypt(await encryptor.encrypt(original))).toEqual(original);
    });

    it('round-trips 500 independently encrypted items', async () => {
        const encryptor = new BoxEncryption(getRandomBytes(32));
        const original = Array.from({ length: 500 }, (_, index) => ({ index, message: `box-item-${index}` }));

        const encrypted = await Promise.all(original.map(async (item) => (await encryptor.encrypt([item]))[0]));
        const decrypted = await Promise.all(encrypted.map(async (item) => (await encryptor.decrypt([item]))[0]));

        expect(decrypted).toEqual(original);
    });
});

describe('AES256Encryption', () => {
    it('round-trips a JSON value', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));

        expect(await encryptor.decrypt(await encryptor.encrypt(['Hello, AES!']))).toEqual(['Hello, AES!']);
    });

    it('round-trips a heterogeneous batch', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));
        const original = ['first', { message: 'second' }, [1, 2, 3]];

        expect(await encryptor.decrypt(await encryptor.encrypt(original))).toEqual(original);
    });

    it('handles an empty batch', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));

        expect(await encryptor.encrypt([])).toEqual([]);
        expect(await encryptor.decrypt([])).toEqual([]);
    });

    it('uses a fresh IV for every encryption', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));
        const first = await encryptor.encrypt(['same']);
        const second = await encryptor.encrypt(['same']);

        expect(first[0]).not.toEqual(second[0]);
    });

    it('rejects ciphertext encrypted under another key', async () => {
        const first = new AES256Encryption(getRandomBytes(32));
        const second = new AES256Encryption(getRandomBytes(32));

        expect(await second.decrypt(await first.encrypt([{ secret: true }]))).toEqual([null]);
    });

    it('rejects an unknown envelope version', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));
        const [encrypted] = await encryptor.encrypt([{ versioned: true }]);
        encrypted[0] = 1;

        expect(await encryptor.decrypt([encrypted])).toEqual([null]);
    });

    it('rejects tampered ciphertext', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));
        const [encrypted] = await encryptor.encrypt([{ authenticated: true }]);
        encrypted[encrypted.length - 1] ^= 0xff;

        expect(await encryptor.decrypt([encrypted])).toEqual([null]);
    });

    it('round-trips a moderate payload', async () => {
        const encryptor = new AES256Encryption(getRandomBytes(32));
        const original = { text: 'x'.repeat(10 * 1024), sequence: 42 };

        expect(await encryptor.decrypt(await encryptor.encrypt([original]))).toEqual([original]);
    });
});
