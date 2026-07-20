import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    values: new Map<string, string>(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-secure-store', () => ({}));

import {
    clearSessionReplayAnchor,
    loadSessionReplayAnchor,
    saveSessionReplayAnchor,
} from './sessionReplayAnchor';

describe('browser session replay consistency marker', () => {
    beforeEach(() => {
        mocks.values.clear();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => mocks.values.get(key) ?? null,
            setItem: (key: string, value: string) => mocks.values.set(key, value),
            removeItem: (key: string) => mocks.values.delete(key),
        });
    });

    it('labels browser storage as consistency-only rather than rollback-resistant', async () => {
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'missing',
            protection: 'browser-consistency-only',
        });

        const anchor = {
            version: 1 as const,
            accountCommitment: 'account-commitment',
            epoch: 2,
            ciphertextCommitment: 'ciphertext-commitment',
        };
        await saveSessionReplayAnchor(anchor);
        await expect(loadSessionReplayAnchor()).resolves.toEqual({
            status: 'available',
            protection: 'browser-consistency-only',
            anchor,
        });

        await clearSessionReplayAnchor();
        await expect(loadSessionReplayAnchor()).resolves.toMatchObject({
            status: 'missing',
            protection: 'browser-consistency-only',
        });
    });
});
