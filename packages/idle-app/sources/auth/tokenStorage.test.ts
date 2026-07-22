import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'web' },
    secureStore: {
        getItemAsync: vi.fn(),
        setItemAsync: vi.fn(),
        deleteItemAsync: vi.fn(),
    },
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-secure-store', () => mocks.secureStore);

import { TokenStorage } from './tokenStorage';

function createMockStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: key => values.get(key) ?? null,
        key: index => [...values.keys()][index] ?? null,
        removeItem: key => { values.delete(key); },
        setItem: (key, value) => { values.set(key, value); },
    };
}

describe('TokenStorage', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.platform.OS = 'web';
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: createMockStorage(),
        });
        await TokenStorage.removeCredentials();
    });

    it('keeps web credentials in memory without writing browser persistence', async () => {
        const credentials = { token: 'synthetic-token', secret: 'synthetic-secret' };

        await expect(TokenStorage.setCredentials(credentials)).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual(credentials);
        expect(localStorage.length).toBe(0);
        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });

    it('removes legacy persisted web credentials instead of loading them', async () => {
        localStorage.setItem('auth_credentials', JSON.stringify({
            token: 'legacy-token',
            secret: 'legacy-secret',
        }));

        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
        expect(localStorage.getItem('auth_credentials')).toBeNull();
    });

    it('rejects invalid runtime values before writing them', async () => {
        await expect(TokenStorage.setCredentials({ token: '', secret: 'value' }))
            .rejects.toThrow(/invalid credentials/i);
        expect(localStorage.length).toBe(0);
    });

    it('uses SecureStore exclusively on native platforms', async () => {
        mocks.platform.OS = 'ios';
        const credentials = { token: 'native-token', secret: 'native-secret' };
        mocks.secureStore.getItemAsync.mockResolvedValue(JSON.stringify(credentials));
        mocks.secureStore.setItemAsync.mockResolvedValue(undefined);
        mocks.secureStore.deleteItemAsync.mockResolvedValue(undefined);

        await expect(TokenStorage.setCredentials(credentials)).resolves.toBe(true);
        await expect(TokenStorage.getCredentials()).resolves.toEqual(credentials);
        await expect(TokenStorage.removeCredentials()).resolves.toBe(true);

        expect(mocks.secureStore.setItemAsync).toHaveBeenCalledWith(
            'auth_credentials',
            JSON.stringify(credentials),
        );
        expect(mocks.secureStore.deleteItemAsync).toHaveBeenCalledWith('auth_credentials');
        expect(localStorage.length).toBe(0);
    });

    it('fails closed for corrupt native credential data', async () => {
        mocks.platform.OS = 'ios';
        mocks.secureStore.getItemAsync.mockResolvedValue(JSON.stringify({ token: 7, secret: [] }));

        await expect(TokenStorage.getCredentials()).resolves.toBeNull();
    });
});
