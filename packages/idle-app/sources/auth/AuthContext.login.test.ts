import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    setCredentials: vi.fn(),
    syncCreate: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        setCredentials: mocks.setCredentials,
        removeCredentials: vi.fn(),
    },
}));
vi.mock('@/sync/sync', () => ({ syncCreate: mocks.syncCreate }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: vi.fn() } }));
vi.mock('@/sync/pushTokenStorage', () => ({ loadRegisteredPushToken: vi.fn() }));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({
    setServerUrl: vi.fn(),
    validateServerUrl: vi.fn(() => ({ valid: true })),
}));
vi.mock('@/sync/sessionReplayAnchor', () => ({ clearSessionReplayAnchor: vi.fn() }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));

import { AuthProvider, useAuth } from './AuthContext';

describe('authentication transition', () => {
    let auth: ReturnType<typeof useAuth>;
    let resolveSync: (() => void) | undefined;

    function Probe() {
        auth = useAuth();
        return null;
    }

    beforeEach(() => {
        mocks.setCredentials.mockReset();
        mocks.syncCreate.mockReset();
        mocks.setCredentials.mockResolvedValue(true);
        mocks.syncCreate.mockImplementation(() => new Promise<void>((resolve) => {
            resolveSync = resolve;
        }));
    });

    it('authenticates after durable credential storage without waiting for initial sync', async () => {
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: null },
                React.createElement(Probe),
            ));
        });

        let loginPromise!: Promise<void>;
        await act(async () => {
            loginPromise = auth.login('new-account-token', 'new-account-secret');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(mocks.setCredentials).toHaveBeenCalledWith({
            token: 'new-account-token',
            secret: 'new-account-secret',
        });
        expect(mocks.syncCreate).toHaveBeenCalledOnce();
        expect(auth.credentials).toEqual({
            token: 'new-account-token',
            secret: 'new-account-secret',
        });
        expect(auth.isAuthenticated).toBe(true);
        await expect(loginPromise).resolves.toBeUndefined();

        resolveSync?.();
        await act(async () => {
            await Promise.resolve();
            renderer!.unmount();
        });
    });
});
