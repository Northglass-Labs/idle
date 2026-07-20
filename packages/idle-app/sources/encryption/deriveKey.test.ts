import { describe, it, expect, vi } from 'vitest';
import { encode as encodeHex } from '@stablelib/hex';
import { deriveKey, deriveSecretKeyTreeRoot, deriveSecretKeyTreeChild } from './deriveKey';
import { encodeUTF8 } from './text';

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA512: 'SHA-512' },
    digest: async (_algorithm: string, data: Uint8Array) => {
        const { createHash } = require('node:crypto');
        const hash: Buffer = createHash('sha512').update(data).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    },
}));

describe('Key Derivation Tests', () => {
    // Test vectors
    const testVectors = [
        {
            seed: encodeUTF8('test seed'),
            usage: 'test usage',
            path: ['child1', 'child2'],
            expectedRootKey: 'E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74', // gitleaks:allow -- deterministic test vector
            expectedRootChainCode: '81ECFD529E8EF95DD5C06CFE169158CF02B7C09A33746C527B4BD4D740B9CC5A', // gitleaks:allow -- deterministic test vector
            expectedChildKey: 'D5EAE039FB9143E9433BB1ADC104C2FF5D7FA6751E680B4B1CBC7ADF1AF65BF3', // gitleaks:allow -- deterministic test vector
            expectedChildChainCode: '8AA339189BAB38B51DD8770B1498682BCB03E42240E273041ACC7E3DF62FE868', // gitleaks:allow -- deterministic test vector
            expectedFinalKey: '1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75', // gitleaks:allow -- deterministic test vector
            expectedFinalChainCode: 'BE98EF894B1C62B8253B480DD415B6EB707028362F2FCECF2CB3871DB8B007F1' // gitleaks:allow -- deterministic test vector
        }
    ];

    it('deriveSecretKeyTreeRoot should produce correct root key and chain code', async () => {
        for (const vector of testVectors) {
            const result = await deriveSecretKeyTreeRoot(vector.seed, vector.usage);
            expect(encodeHex(result.key)).toEqual(vector.expectedRootKey);
            expect(encodeHex(result.chainCode)).toEqual(vector.expectedRootChainCode);
        }
    });

    it('deriveSecretKeyTreeChild should produce correct child key and chain code', async () => {
        for (const vector of testVectors) {
            const rootState = await deriveSecretKeyTreeRoot(vector.seed, vector.usage);
            const childState = await deriveSecretKeyTreeChild(rootState.chainCode, vector.path[0]);
            const childState2 = await deriveSecretKeyTreeChild(childState.chainCode, vector.path[1]);
            expect(encodeHex(childState.key)).toEqual(vector.expectedChildKey);
            expect(encodeHex(childState.chainCode)).toEqual(vector.expectedChildChainCode);
            expect(encodeHex(childState2.key)).toEqual(vector.expectedFinalKey);
            expect(encodeHex(childState2.chainCode)).toEqual(vector.expectedFinalChainCode);
        }
    });

    it('deriveKey should produce correct final key for given path', async () => {
        for (const vector of testVectors) {
            const result = await deriveKey(vector.seed, vector.usage, vector.path);
            expect(encodeHex(result)).toEqual(vector.expectedFinalKey);
        }
    });

    it('deriveKey should be deterministic', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage, vector.path);
            expect(encodeHex(result1)).toEqual(encodeHex(result2));
        }
    });

    it('deriveKey should produce different keys for different paths', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage, [...vector.path, 'additional']);
            expect(encodeHex(result1)).not.toEqual(encodeHex(result2));
        }
    });

    it('deriveKey should produce different keys for different usages', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage + 'different', vector.path);
            expect(encodeHex(result1)).not.toEqual(encodeHex(result2));
        }
    });
});
