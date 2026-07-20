import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    legacy: new Map<string, string>(),
    secureDelete: vi.fn(),
    secureGet: vi.fn(),
    secureSet: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
    deleteItemAsync: mocks.secureDelete,
    getItemAsync: mocks.secureGet,
    setItemAsync: mocks.secureSet,
}));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return mocks.legacy.get(key); }
        delete(key: string) { mocks.legacy.delete(key); }
    },
}));

import {
    clearRegisteredPushToken,
    loadRegisteredPushToken,
    saveRegisteredPushToken,
} from './pushTokenStorage';

describe('push token secure storage', () => {
    beforeEach(() => {
        mocks.legacy.clear();
        mocks.secureDelete.mockReset();
        mocks.secureGet.mockReset();
        mocks.secureSet.mockReset();
        mocks.secureGet.mockResolvedValue(null);
    });

    it('stores and removes push tokens through the native secure store', async () => {
        await saveRegisteredPushToken('ExponentPushToken[test-token]');
        expect(mocks.secureSet).toHaveBeenCalledWith(
            'idle_registered_push_token_v2',
            'ExponentPushToken[test-token]',
        );

        await clearRegisteredPushToken();
        expect(mocks.secureDelete).toHaveBeenCalledWith('idle_registered_push_token_v2');
    });

    it('migrates and shreds the legacy plaintext MMKV token', async () => {
        mocks.legacy.set('registered-push-token-v1', 'ExponentPushToken[legacy-token]');

        await expect(loadRegisteredPushToken()).resolves.toBe('ExponentPushToken[legacy-token]');
        expect(mocks.secureSet).toHaveBeenCalledWith(
            'idle_registered_push_token_v2',
            'ExponentPushToken[legacy-token]',
        );
        expect(mocks.legacy.has('registered-push-token-v1')).toBe(false);
    });

    it('rejects invalid or oversized token material', async () => {
        await expect(saveRegisteredPushToken('')).rejects.toThrow(/invalid/i);
        await expect(saveRegisteredPushToken('x'.repeat(2_049))).rejects.toThrow(/invalid/i);
        expect(mocks.secureSet).not.toHaveBeenCalled();
    });
});
