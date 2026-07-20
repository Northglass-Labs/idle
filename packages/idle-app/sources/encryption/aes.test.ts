import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptAESGCM, decryptAESGCMString, encryptAESGCM, encryptAESGCMString } from './aes';
import { encodeBase64 } from './base64';

const native = vi.hoisted(() => ({
    encryptAsyncAES: vi.fn(),
    decryptAsyncAES: vi.fn(),
}));

// The native rn-encryption bridge cannot execute in Node. These tests cover
// the adapter's byte/base64 and null-handling contract; aes.web.test.ts covers
// the cryptographic implementation with real Web Crypto.
vi.mock('rn-encryption', () => native);

beforeEach(() => {
    native.encryptAsyncAES.mockReset();
    native.decryptAsyncAES.mockReset();
});

describe('AES Tests', () => {
    it('should encrypt and decrypt a string', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(7));
        native.encryptAsyncAES.mockResolvedValue('encrypted-payload');
        native.decryptAsyncAES.mockResolvedValue('  "Hello, World!"  ');

        const encrypted = await encryptAESGCMString('"Hello, World!"', key);
        expect(encrypted).toBe('encrypted-payload');
        expect(native.encryptAsyncAES).toHaveBeenCalledWith('"Hello, World!"', key);

        const decrypted = await decryptAESGCMString(encrypted, key);
        expect(decrypted).toBe('"Hello, World!"');
        expect(native.decryptAsyncAES).toHaveBeenCalledWith(encrypted, key);
    });

    it('should encrypt and decrypt a Uint8Array', async () => {
        const key = encodeBase64(new Uint8Array(32).fill(9));
        const ciphertext = new Uint8Array([0, 1, 254, 255]);
        native.encryptAsyncAES.mockResolvedValue(`  ${encodeBase64(ciphertext)}  `);
        native.decryptAsyncAES.mockResolvedValue('Hello, World!');

        const plaintext = new TextEncoder().encode('Hello, World!');
        const encrypted = await encryptAESGCM(plaintext, key);
        expect(encrypted).toEqual(ciphertext);
        expect(native.encryptAsyncAES).toHaveBeenCalledWith('Hello, World!', key);

        const decrypted = await decryptAESGCM(encrypted, key);
        expect(decrypted).toEqual(plaintext);
        expect(native.decryptAsyncAES).toHaveBeenCalledWith(encodeBase64(ciphertext), key);
    });

    it('returns null when the native bridge cannot decrypt', async () => {
        native.decryptAsyncAES.mockResolvedValue('');

        await expect(decryptAESGCM(new Uint8Array([1, 2, 3]), encodeBase64(new Uint8Array(32)))).resolves.toBeNull();
    });
});
