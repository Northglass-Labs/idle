/**
 * Encrypted persistence for session ordering via UserKVStore.
 *
 * The user's preferred session order is stored as an encrypted JSON array
 * of session IDs in the KV store under key "session-order". The server
 * only sees ciphertext — zero knowledge of ordering.
 *
 * Uses the same encryptRaw/decryptRaw pattern as settings sync.
 */

import { kvGet, kvSet } from './apiKv';
import { Encryption } from './encryption/encryption';
import { AuthCredentials } from '@/auth/tokenStorage';
import { log } from '@/log';
import { normalizeSessionOrder, SessionOrderV2 } from './sessionOrder';

const SESSION_ORDER_KEY = 'session-order';

/** Cached state to avoid re-fetching on every render */
let cachedOrder: string[] = [];
let cachedVersion: number = -1;

/**
 * Load the session order from the encrypted KV store.
 * Returns the order array, or an empty array if no order is saved.
 */
export async function loadSessionOrder(
    credentials: AuthCredentials,
    encryption: Encryption
): Promise<string[]> {
    try {
        const item = await kvGet(credentials, SESSION_ORDER_KEY);
        if (!item) {
            cachedOrder = [];
            cachedVersion = -1;
            return [];
        }

        // Decrypt the value (server stores ciphertext)
        const decrypted = await encryption.decryptRaw(item.value);
        if (!decrypted || !Array.isArray(decrypted)) {
            cachedOrder = [];
            cachedVersion = item.version;
            return [];
        }

        cachedOrder = decrypted as string[];
        cachedVersion = item.version;
        return cachedOrder;
    } catch (error) {
        log.log('sessionOrder: Failed to load session order');
        return cachedOrder; // Return last known good order on failure
    }
}

/**
 * Save the session order to the encrypted KV store.
 * Encrypts the order array client-side before sending to server.
 */
export async function saveSessionOrder(
    credentials: AuthCredentials,
    encryption: Encryption,
    order: string[]
): Promise<void> {
    try {
        const encrypted = await encryption.encryptRaw(order);
        const newVersion = await kvSet(credentials, SESSION_ORDER_KEY, encrypted, cachedVersion);
        cachedOrder = order;
        cachedVersion = newVersion;
    } catch (error) {
        log.log('sessionOrder: Failed to save session order');
        // On version mismatch, re-fetch and retry once
        if (error instanceof Error && error.message.includes('version-mismatch')) {
            try {
                await loadSessionOrder(credentials, encryption);
                const encrypted = await encryption.encryptRaw(order);
                const newVersion = await kvSet(credentials, SESSION_ORDER_KEY, encrypted, cachedVersion);
                cachedOrder = order;
                cachedVersion = newVersion;
            } catch (retryError) {
                log.log('sessionOrder: Retry save failed');
            }
        }
    }
}

/**
 * Get the cached session order without a network call.
 * Returns empty array if order hasn't been loaded yet.
 */
export function getCachedSessionOrder(): string[] {
    return cachedOrder;
}

/**
 * Reset the cached order (for logout or testing).
 */
export function resetSessionOrderCache(): void {
    cachedOrder = [];
    cachedOrderV2 = { version: 2, groups: [], ungrouped: [] };
    cachedVersion = -1;
    notifyV2Subscribers();
}

// === V2: Session Groups Persistence ===

let cachedOrderV2: SessionOrderV2 = { version: 2, groups: [], ungrouped: [] };

// Subscriber set for V2 cache changes. The Sessions list (and any other
// reorder/group-aware UI) calls subscribeSessionOrderV2 to re-render when the
// encrypted V2 order arrives from KV or is mutated locally via sync.*Group ops.
// Module-level emitter, not Zustand, to keep this file dependency-free and
// runnable in pure-Node tests.
const v2Subscribers = new Set<() => void>();

function notifyV2Subscribers(): void {
    for (const cb of v2Subscribers) {
        try {
            cb();
        } catch {
            // Swallow — a broken subscriber must not break sibling subscribers
            // or the save path that triggered the notification.
        }
    }
}

export function subscribeSessionOrderV2(cb: () => void): () => void {
    v2Subscribers.add(cb);
    return () => {
        v2Subscribers.delete(cb);
    };
}

/**
 * Load the session order from the encrypted KV store, normalizing to V2 format.
 * Automatically migrates V1 arrays to V2 structure.
 */
export async function loadSessionOrderV2(
    credentials: AuthCredentials,
    encryption: Encryption
): Promise<SessionOrderV2> {
    try {
        const item = await kvGet(credentials, SESSION_ORDER_KEY);
        if (!item) {
            cachedOrderV2 = { version: 2, groups: [], ungrouped: [] };
            cachedVersion = -1;
            return cachedOrderV2;
        }
        const decrypted = await encryption.decryptRaw(item.value);
        cachedOrderV2 = normalizeSessionOrder(decrypted);
        cachedVersion = item.version;
        notifyV2Subscribers();
        return cachedOrderV2;
    } catch (error) {
        log.log('sessionOrder: Failed to load v2 session order');
        return cachedOrderV2;
    }
}

/**
 * Save the V2 session order to the encrypted KV store.
 * Encrypts client-side before sending to server.
 */
export async function saveSessionOrderV2(
    credentials: AuthCredentials,
    encryption: Encryption,
    order: SessionOrderV2
): Promise<void> {
    try {
        const encrypted = await encryption.encryptRaw(order);
        const newVersion = await kvSet(credentials, SESSION_ORDER_KEY, encrypted, cachedVersion);
        cachedOrderV2 = order;
        cachedVersion = newVersion;
        notifyV2Subscribers();
    } catch (error) {
        log.log('sessionOrder: Failed to save v2 session order');
        if (error instanceof Error && error.message.includes('version-mismatch')) {
            try {
                await loadSessionOrderV2(credentials, encryption);
                const encrypted = await encryption.encryptRaw(order);
                const newVersion = await kvSet(credentials, SESSION_ORDER_KEY, encrypted, cachedVersion);
                cachedOrderV2 = order;
                cachedVersion = newVersion;
                notifyV2Subscribers();
            } catch (retryError) {
                log.log('sessionOrder: Retry v2 save failed');
            }
        }
    }
}

/**
 * Get the cached V2 session order without a network call.
 * Returns empty V2 structure if order hasn't been loaded yet.
 */
export function getCachedSessionOrderV2(): SessionOrderV2 {
    return cachedOrderV2;
}
