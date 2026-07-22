import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const AUTH_KEY = 'auth_credentials';
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_SECRET_LENGTH = 4 * 1024;
let webCredentials: AuthCredentials | null = null;

export interface AuthCredentials {
    token: string;
    secret: string;
}

function isCredentialField(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && !/[\s\0]/.test(value);
}

function isAuthCredentials(value: unknown): value is AuthCredentials {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && isCredentialField((value as { token?: unknown }).token, MAX_TOKEN_LENGTH)
        && isCredentialField((value as { secret?: unknown }).secret, MAX_SECRET_LENGTH);
}

function parseCredentials(serialized: string | null): AuthCredentials | null {
    if (!serialized || serialized.length > MAX_TOKEN_LENGTH + MAX_SECRET_LENGTH + 128) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(serialized);
        return isAuthCredentials(value) ? value : null;
    } catch {
        return null;
    }
}

function serializeCredentials(credentials: AuthCredentials): string {
    if (!isAuthCredentials(credentials)) {
        throw new Error('Invalid credentials');
    }
    return JSON.stringify(credentials);
}

function removeLegacyWebCredentials(): boolean {
    if (typeof localStorage === 'undefined') return true;
    try {
        localStorage.removeItem(AUTH_KEY);
        return localStorage.getItem(AUTH_KEY) === null;
    } catch {
        return false;
    }
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            if (!removeLegacyWebCredentials()) return null;
            return webCredentials ? { ...webCredentials } : null;
        }
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            return parseCredentials(stored);
        } catch {
            console.warn('Secure credential read failed');
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const json = serializeCredentials(credentials);
        if (Platform.OS === 'web') {
            if (!removeLegacyWebCredentials()) {
                throw new Error('Legacy web credential cleanup failed');
            }
            webCredentials = { ...credentials };
            return true;
        }
        try {
            await SecureStore.setItemAsync(AUTH_KEY, json);
            return true;
        } catch (error) {
            // Preserve the storage error class for callers without including
            // credential material in the diagnostic.
            const errorClass = error instanceof Error ? error.name : 'UnknownError';
            throw new Error(`Secure credential storage failed (${errorClass})`);
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {
            webCredentials = null;
            return removeLegacyWebCredentials();
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            return true;
        } catch {
            console.warn('Secure credential removal failed');
            return false;
        }
    },
};
