import { describe, expect, it, vi } from 'vitest';

import { resolveMachineDataKey } from './machineKeyPolicy';

describe('machine data-key downgrade policy', () => {
    it('uses legacy encryption only when the server explicitly omits a current key', async () => {
        const decrypt = vi.fn();

        await expect(resolveMachineDataKey(null, decrypt)).resolves.toEqual({ kind: 'legacy' });
        expect(decrypt).not.toHaveBeenCalled();
    });

    it('fails closed when a present current-key bundle cannot be authenticated', async () => {
        const decrypt = vi.fn(async () => null);

        await expect(resolveMachineDataKey('present-but-invalid', decrypt)).resolves.toEqual({ kind: 'invalid' });
        expect(decrypt).toHaveBeenCalledWith('present-but-invalid');
    });

    it('returns the authenticated current key without falling back', async () => {
        const key = new Uint8Array(32).fill(7);
        const decrypt = vi.fn(async () => key);

        await expect(resolveMachineDataKey('valid-bundle', decrypt)).resolves.toEqual({ kind: 'current', key });
    });

    it('treats decryption errors as invalid current keys', async () => {
        const decrypt = vi.fn(async () => { throw new Error('malformed'); });

        await expect(resolveMachineDataKey('malformed-bundle', decrypt)).resolves.toEqual({ kind: 'invalid' });
    });
});
