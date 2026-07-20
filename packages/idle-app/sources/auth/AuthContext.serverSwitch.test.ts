import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    order: [] as string[],
    removeCredentials: vi.fn(),
    unregisterPushToken: vi.fn(),
    reloadAsync: vi.fn(),
    setServerUrl: vi.fn(),
    clearReplayAnchor: vi.fn(),
    clearPersistence: vi.fn(),
    disconnectSocket: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-updates', () => ({ reloadAsync: mocks.reloadAsync }));
vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        setCredentials: vi.fn(),
        removeCredentials: mocks.removeCredentials,
    },
}));
vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('@/sync/persistence', () => ({
    clearPersistence: mocks.clearPersistence,
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { disconnect: mocks.disconnectSocket },
}));
vi.mock('@/sync/pushTokenStorage', () => ({
    loadRegisteredPushToken: async () => 'push-token',
}));
vi.mock('@/sync/apiPush', () => ({
    unregisterPushToken: mocks.unregisterPushToken,
}));
vi.mock('@/sync/serverConfig', () => ({
    setServerUrl: mocks.setServerUrl,
    validateServerUrl: () => ({ valid: true }),
}));
vi.mock('@/sync/sessionReplayAnchor', () => ({
    clearSessionReplayAnchor: mocks.clearReplayAnchor,
}));
vi.mock('@/track', () => ({ trackLogout: () => { mocks.order.push('track-logout'); } }));

import { AuthProvider, useAuth } from './AuthContext';

describe('authenticated server switching', () => {
    let auth: ReturnType<typeof useAuth>;

    function Probe() {
        auth = useAuth();
        return null;
    }

    beforeEach(() => {
        mocks.order.length = 0;
        mocks.removeCredentials.mockReset();
        mocks.unregisterPushToken.mockReset();
        mocks.reloadAsync.mockReset();
        mocks.setServerUrl.mockReset();
        mocks.clearReplayAnchor.mockReset();
        mocks.clearPersistence.mockReset();
        mocks.disconnectSocket.mockReset();
        mocks.removeCredentials.mockImplementation(async () => {
            mocks.order.push('remove-credentials');
            return true;
        });
        mocks.unregisterPushToken.mockImplementation(async () => {
            mocks.order.push('unregister-old-origin');
        });
        mocks.setServerUrl.mockImplementation(() => {
            mocks.order.push('set-new-origin');
        });
        mocks.clearReplayAnchor.mockImplementation(async () => {
            mocks.order.push('clear-replay-anchor');
        });
        mocks.clearPersistence.mockImplementation(() => {
            mocks.order.push('clear-persistence');
        });
        mocks.disconnectSocket.mockImplementation(() => {
            mocks.order.push('disconnect-socket');
        });
        mocks.reloadAsync.mockImplementation(async () => {
            mocks.order.push('reload');
        });
    });

    it('clears the old credential before changing the relay origin', async () => {
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await auth.switchServer('https://relay-b.example');
        });

        expect(mocks.unregisterPushToken).toHaveBeenCalledWith(
            { token: 'relay-a-token', secret: 'content-secret' },
            'push-token',
        );
        expect(mocks.setServerUrl).toHaveBeenCalledWith('https://relay-b.example');
        expect(mocks.order).toEqual([
            'track-logout',
            'unregister-old-origin',
            'remove-credentials',
            'disconnect-socket',
            'clear-replay-anchor',
            'clear-persistence',
            'set-new-origin',
            'reload',
        ]);
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('does not change origins when credential removal fails', async () => {
        mocks.removeCredentials.mockImplementation(async () => {
            mocks.order.push('remove-credentials');
            return false;
        });
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await expect(auth.switchServer('https://relay-b.example')).rejects.toThrow(/credentials/i);
        expect(mocks.setServerUrl).not.toHaveBeenCalled();
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(mocks.clearReplayAnchor).not.toHaveBeenCalled();
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.disconnectSocket).not.toHaveBeenCalled();
        expect(auth.credentials).toEqual({ token: 'relay-a-token', secret: 'content-secret' });
        expect(auth.isAuthenticated).toBe(true);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('shuts down authenticated state after credential removal even when replay-anchor cleanup fails', async () => {
        mocks.clearReplayAnchor.mockRejectedValue(new Error('secure storage unavailable'));
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await expect(auth.switchServer('https://relay-b.example')).rejects.toThrow(/secure storage/i);
        });
        expect(mocks.removeCredentials).toHaveBeenCalledOnce();
        expect(mocks.disconnectSocket).toHaveBeenCalledOnce();
        expect(mocks.setServerUrl).not.toHaveBeenCalled();
        expect(mocks.order).not.toContain('clear-persistence');
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('does not complete logout while the registered push token remains attached', async () => {
        mocks.unregisterPushToken.mockRejectedValue(new Error('relay unavailable'));
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await expect(auth.logout()).rejects.toThrow(/push token/i);
        expect(mocks.removeCredentials).not.toHaveBeenCalled();
        expect(mocks.order).not.toContain('clear-persistence');
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toEqual({ token: 'relay-a-token', secret: 'content-secret' });
        expect(auth.isAuthenticated).toBe(true);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('retains both replay halves and authenticated state when logout credential removal fails', async () => {
        mocks.removeCredentials.mockImplementation(async () => {
            mocks.order.push('remove-credentials');
            return false;
        });
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await expect(auth.logout()).rejects.toThrow(/credentials/i);

        expect(mocks.order).toEqual([
            'track-logout',
            'unregister-old-origin',
            'remove-credentials',
        ]);
        expect(mocks.clearReplayAnchor).not.toHaveBeenCalled();
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.disconnectSocket).not.toHaveBeenCalled();
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toEqual({ token: 'relay-a-token', secret: 'content-secret' });
        expect(auth.isAuthenticated).toBe(true);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('keeps auth shut down when persistence cleanup fails after successful credential removal', async () => {
        mocks.clearPersistence.mockImplementation(() => {
            mocks.order.push('clear-persistence');
            throw new Error('persistence unavailable');
        });
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await expect(auth.logout()).rejects.toThrow(/persistence unavailable/i);
        });

        expect(mocks.order).toEqual([
            'track-logout',
            'unregister-old-origin',
            'remove-credentials',
            'disconnect-socket',
            'clear-replay-anchor',
            'clear-persistence',
        ]);
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('keeps auth shut down and the persistence half intact when logout anchor cleanup fails', async () => {
        mocks.clearReplayAnchor.mockRejectedValue(new Error('secure storage unavailable'));
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await expect(auth.logout()).rejects.toThrow(/secure storage/i);
        });

        expect(mocks.order).toEqual([
            'track-logout',
            'unregister-old-origin',
            'remove-credentials',
            'disconnect-socket',
        ]);
        expect(mocks.clearPersistence).not.toHaveBeenCalled();
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('does not switch origins when persistence cleanup fails after anchor deletion', async () => {
        mocks.clearPersistence.mockImplementation(() => {
            mocks.order.push('clear-persistence');
            throw new Error('persistence unavailable');
        });
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await expect(auth.switchServer('https://relay-b.example')).rejects.toThrow(/persistence unavailable/i);
        });

        expect(mocks.order).toEqual([
            'track-logout',
            'unregister-old-origin',
            'remove-credentials',
            'disconnect-socket',
            'clear-replay-anchor',
            'clear-persistence',
        ]);
        expect(mocks.setServerUrl).not.toHaveBeenCalled();
        expect(mocks.reloadAsync).not.toHaveBeenCalled();
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('does not switch origins while the old push token remains attached', async () => {
        mocks.unregisterPushToken.mockRejectedValue(new Error('relay unavailable'));
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'relay-a-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await expect(auth.switchServer('https://relay-b.example')).rejects.toThrow(/push token/i);
        expect(mocks.removeCredentials).not.toHaveBeenCalled();
        expect(mocks.setServerUrl).not.toHaveBeenCalled();
        expect(mocks.order).not.toContain('clear-persistence');
        expect(auth.credentials).toEqual({ token: 'relay-a-token', secret: 'content-secret' });

        await act(async () => {
            renderer!.unmount();
        });
    });

    it('allows local cleanup after account deletion already removed server push tokens', async () => {
        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(
                AuthProvider,
                { initialCredentials: { token: 'deleted-account-token', secret: 'content-secret' } },
                React.createElement(Probe),
            ));
        });

        await act(async () => {
            await auth.logout({ pushTokenAlreadyRemoved: true });
        });

        expect(mocks.unregisterPushToken).not.toHaveBeenCalled();
        expect(mocks.clearReplayAnchor).toHaveBeenCalledOnce();
        expect(mocks.removeCredentials).toHaveBeenCalledOnce();
        expect(auth.credentials).toBeNull();

        await act(async () => {
            renderer!.unmount();
        });
    });
});
