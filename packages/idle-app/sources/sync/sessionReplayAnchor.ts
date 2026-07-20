import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { z } from 'zod';

const SESSION_REPLAY_ANCHOR_KEY = 'idle_session_replay_anchor_v1';
const MAX_COMMITMENT_LENGTH = 256;

export const SessionReplayAnchorSchema = z.object({
    version: z.literal(1),
    accountCommitment: z.string().min(1).max(MAX_COMMITMENT_LENGTH),
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ciphertextCommitment: z.string().min(1).max(MAX_COMMITMENT_LENGTH),
}).strict();

export type SessionReplayAnchor = z.infer<typeof SessionReplayAnchorSchema>;
type AnchorProtection = 'device-secure' | 'browser-consistency-only';

export type SessionReplayAnchorLoadResult =
    | { status: 'missing'; protection: AnchorProtection }
    | { status: 'corrupt'; protection: AnchorProtection }
    | { status: 'unavailable'; protection: AnchorProtection }
    | {
        status: 'available';
        protection: AnchorProtection;
        anchor: SessionReplayAnchor;
    };

function parseAnchor(
    serialized: string | null,
    protection: AnchorProtection,
): SessionReplayAnchorLoadResult {
    if (serialized === null) {
        return { status: 'missing', protection };
    }
    if (serialized.length > 1_024) {
        return { status: 'corrupt', protection };
    }
    try {
        const parsed = SessionReplayAnchorSchema.safeParse(JSON.parse(serialized));
        return parsed.success
            ? { status: 'available', protection, anchor: parsed.data }
            : { status: 'corrupt', protection };
    } catch {
        return { status: 'corrupt', protection };
    }
}

export async function loadSessionReplayAnchor(): Promise<SessionReplayAnchorLoadResult> {
    if (Platform.OS === 'web') {
        try {
            if (typeof localStorage === 'undefined') {
                return { status: 'unavailable', protection: 'browser-consistency-only' };
            }
            return parseAnchor(
                localStorage.getItem(SESSION_REPLAY_ANCHOR_KEY),
                'browser-consistency-only',
            );
        } catch {
            return { status: 'unavailable', protection: 'browser-consistency-only' };
        }
    }

    try {
        return parseAnchor(
            await SecureStore.getItemAsync(SESSION_REPLAY_ANCHOR_KEY),
            'device-secure',
        );
    } catch {
        return { status: 'unavailable', protection: 'device-secure' };
    }
}

export async function saveSessionReplayAnchor(anchor: SessionReplayAnchor): Promise<void> {
    const serialized = JSON.stringify(SessionReplayAnchorSchema.parse(anchor));
    if (Platform.OS === 'web') {
        if (typeof localStorage === 'undefined') {
            throw new Error('Browser replay anchor storage unavailable');
        }
        localStorage.setItem(SESSION_REPLAY_ANCHOR_KEY, serialized);
        return;
    }

    await SecureStore.setItemAsync(SESSION_REPLAY_ANCHOR_KEY, serialized, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
}

export async function clearSessionReplayAnchor(): Promise<void> {
    if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(SESSION_REPLAY_ANCHOR_KEY);
        }
        return;
    }
    await SecureStore.deleteItemAsync(SESSION_REPLAY_ANCHOR_KEY);
}
