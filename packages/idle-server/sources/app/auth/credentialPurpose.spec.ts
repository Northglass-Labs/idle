import { describe, expect, it } from 'vitest';

import {
    RPC_REGISTRATION_CREDENTIAL_PURPOSE,
    canCredentialRegisterRpc,
    canCredentialUseHttp,
    canCredentialUseSocketScope,
} from './credentialPurpose';

describe('authentication credential purpose boundaries', () => {
    it('keeps an ordinary bearer usable but unable to register RPC targets', () => {
        expect(canCredentialUseHttp(undefined)).toBe(true);
        expect(canCredentialUseSocketScope(undefined, 'user-scoped')).toBe(true);
        expect(canCredentialUseSocketScope(undefined, 'session-scoped')).toBe(true);
        expect(canCredentialRegisterRpc(undefined)).toBe(false);
    });

    it('limits the dedicated registration credential to scoped sockets', () => {
        const extras = { credentialPurpose: RPC_REGISTRATION_CREDENTIAL_PURPOSE };

        expect(canCredentialUseHttp(extras)).toBe(false);
        expect(canCredentialUseSocketScope(extras, 'user-scoped')).toBe(false);
        expect(canCredentialUseSocketScope(extras, 'session-scoped')).toBe(true);
        expect(canCredentialUseSocketScope(extras, 'machine-scoped')).toBe(true);
        expect(canCredentialRegisterRpc(extras)).toBe(true);
    });

    it('keeps an exact legacy terminal bearer usable for migration but unable to register RPC targets', () => {
        expect(canCredentialUseHttp({ session: 'legacy-pairing-id' })).toBe(true);
        expect(canCredentialUseSocketScope({ session: 'legacy-pairing-id' }, 'session-scoped')).toBe(true);
        expect(canCredentialUseSocketScope({ session: 'legacy-pairing-id' }, 'machine-scoped')).toBe(true);
        expect(canCredentialRegisterRpc({ session: 'legacy-pairing-id' })).toBe(false);

        for (const extras of [
            { session: '' },
            { session: 'legacy-pairing-id', extra: true },
            { credentialPurpose: RPC_REGISTRATION_CREDENTIAL_PURPOSE, extra: true },
            { credentialPurpose: 'rpc-registration' },
            null,
            [],
        ]) {
            expect(canCredentialRegisterRpc(extras)).toBe(false);
        }
    });
});
