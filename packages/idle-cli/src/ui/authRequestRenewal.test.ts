import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    axiosGet: vi.fn(),
    axiosPost: vi.fn(),
    delay: vi.fn(),
    writeCredentialsLegacy: vi.fn(),
    decryptPairingCredentials: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        get: testState.axiosGet,
        post: testState.axiosPost,
    },
}));
vi.mock('@/api/encryption', () => ({
    encodeBase64: () => 'OPAQUE_PAIRING_PUBLIC_KEY',
    encodeBase64Url: () => 'OPAQUE_PAIRING_PUBLIC_KEY_URL',
}));
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://relay.invalid',
        currentCliVersion: '1.2.3',
    },
}));
vi.mock('@/utils/time', () => ({ delay: testState.delay }));
vi.mock('@/persistence', () => ({
    writeCredentialsLegacy: testState.writeCredentialsLegacy,
    writeCredentialsDataKey: vi.fn(),
    readCredentials: vi.fn(),
    updateSettings: vi.fn(),
}));
vi.mock('@/api/webAuth', () => ({ generateWebAuthUrl: vi.fn() }));
vi.mock('@/utils/browser', () => ({ openBrowser: vi.fn() }));
vi.mock('@/api/pairing', () => ({
    decryptPairingCredentials: testState.decryptPairingCredentials,
    usesLegacyTokenOutsidePairingEnvelope: () => false,
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

import { waitForAuthentication } from './auth';

describe('pairing request renewal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        testState.delay.mockResolvedValue(undefined);
        testState.writeCredentialsLegacy.mockResolvedValue(undefined);
        testState.decryptPairingCredentials.mockReturnValue({
            token: 'OPAQUE_PAIRING_TOKEN',
            response: new Uint8Array(32),
        });
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('recreates an expired request with the same displayed public key', async () => {
        testState.axiosGet
            .mockResolvedValueOnce({ data: { status: 'not_found' } })
            .mockResolvedValueOnce({ data: { status: 'authorized' } });
        testState.axiosPost
            .mockResolvedValueOnce({ data: { state: 'requested' } })
            .mockResolvedValueOnce({ data: { state: 'authorized', response: 'OPAQUE_RESPONSE' } });

        const result = await waitForAuthentication({
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(32),
        });

        expect(result?.token).toBe('OPAQUE_PAIRING_TOKEN');
        expect(testState.axiosPost.mock.calls[0][1]).toEqual({
            publicKey: 'OPAQUE_PAIRING_PUBLIC_KEY',
            supportsV2: true,
        });
        expect(Object.values(testState.axiosPost.mock.calls[0][2].headers)).toEqual(['cli/1.2.3']);
        expect(testState.axiosPost).toHaveBeenCalledTimes(2);
        expect(testState.writeCredentialsLegacy).toHaveBeenCalledOnce();
    });
});
