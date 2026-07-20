import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

const SECURE_PUSH_TOKEN_KEY = 'idle_registered_push_token_v2';
const LEGACY_PUSH_TOKEN_KEY = 'registered-push-token-v1';
const MAX_PUSH_TOKEN_LENGTH = 1_024;
const legacyStorage = new MMKV();

function isValidPushToken(token: unknown): token is string {
    return typeof token === 'string'
        && token.length > 0
        && token.length <= MAX_PUSH_TOKEN_LENGTH
        && !/[\s\0]/.test(token);
}

export async function loadRegisteredPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return null;
    }

    try {
        const stored = await SecureStore.getItemAsync(SECURE_PUSH_TOKEN_KEY);
        if (isValidPushToken(stored)) {
            return stored;
        }

        const legacy = legacyStorage.getString(LEGACY_PUSH_TOKEN_KEY);
        if (!isValidPushToken(legacy)) {
            legacyStorage.delete(LEGACY_PUSH_TOKEN_KEY);
            return null;
        }

        await SecureStore.setItemAsync(SECURE_PUSH_TOKEN_KEY, legacy);
        legacyStorage.delete(LEGACY_PUSH_TOKEN_KEY);
        return legacy;
    } catch {
        return null;
    }
}

export async function saveRegisteredPushToken(token: string): Promise<void> {
    if (!isValidPushToken(token)) {
        throw new Error('Invalid push token');
    }
    if (Platform.OS === 'web') {
        return;
    }

    await SecureStore.setItemAsync(SECURE_PUSH_TOKEN_KEY, token);
    legacyStorage.delete(LEGACY_PUSH_TOKEN_KEY);
}

export async function clearRegisteredPushToken(): Promise<void> {
    if (Platform.OS !== 'web') {
        await SecureStore.deleteItemAsync(SECURE_PUSH_TOKEN_KEY);
    }
    legacyStorage.delete(LEGACY_PUSH_TOKEN_KEY);
}
