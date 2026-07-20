import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    stored: null as string | null,
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: mocks.get,
    setItemAsync: mocks.set,
    deleteItemAsync: mocks.remove,
}));

import {
    clearSessionReplayAnchor,
    loadSessionReplayAnchor,
    saveSessionReplayAnchor,
} from './sessionReplayAnchor';

describe('native session replay anchor', () => {
    beforeEach(() => {
        mocks.stored = null;
        mocks.get.mockReset();
        mocks.set.mockReset();
        mocks.remove.mockReset();
        mocks.get.mockImplementation(async () => mocks.stored);
        mocks.set.mockImplementation(async (_key: string, value: string) => {
            mocks.stored = value;
        });
        mocks.remove.mockImplementation(async () => {
            mocks.stored = null;
        });
    });

    it('stores a bounded account-bound epoch and ciphertext commitment device-locally', async () => {
        const anchor = {
            version: 1 as const,
            accountCommitment: 'account-commitment',
            epoch: 4,
            ciphertextCommitment: 'ciphertext-commitment',
        };

        await saveSessionReplayAnchor(anchor);
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'available',
            anchor,
            protection: 'device-secure',
        });
        expect(mocks.set).toHaveBeenCalledWith(
            expect.any(String),
            JSON.stringify(anchor),
            { keychainAccessible: 6 },
        );
    });

    it('distinguishes first use from corrupt or unavailable secure state', async () => {
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'missing',
            protection: 'device-secure',
        });

        mocks.stored = '{not-json';
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'corrupt',
            protection: 'device-secure',
        });

        mocks.get.mockRejectedValueOnce(new Error('keychain unavailable'));
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'unavailable',
            protection: 'device-secure',
        });
    });

    it('clears the device anchor only through the secure store', async () => {
        await clearSessionReplayAnchor();
        expect(mocks.remove).toHaveBeenCalledWith(expect.any(String));
    });
});
