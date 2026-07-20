import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('runtime master secret boundary', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('fails closed before boot injects a secret', async () => {
        const { getRuntimeMasterSecret } = await import('./runtimeMasterSecret');

        expect(() => getRuntimeMasterSecret()).toThrow(/not been initialized/i);
    });

    it('validates injection and returns only the initialized value', async () => {
        const { getRuntimeMasterSecret, setRuntimeMasterSecret } = await import('./runtimeMasterSecret');
        const secret = 'c4'.repeat(32);

        expect(() => setRuntimeMasterSecret('invalid')).toThrow(/64 hexadecimal/i);
        setRuntimeMasterSecret(secret);
        expect(getRuntimeMasterSecret()).toBe(secret);
    });
});
