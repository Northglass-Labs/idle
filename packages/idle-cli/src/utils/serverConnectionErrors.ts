/** Cancellable, backend-neutral relay reconnection with bounded backoff. */

import axios from 'axios';
import { exponentialBackoffDelay } from '@/utils/time';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';

/**
 * Configuration for offline reconnection behavior.
 * Uses dependency injection for testability.
 */
export interface OfflineReconnectionConfig<TSession> {
    /** Server URL to health-check against (e.g., 'https://idle-api.northglass.io') */
    serverUrl: string;

    /**
     * Called when server becomes available - should create and return session.
     * If this throws, it's treated as a connection error and retried.
     */
    onReconnected: () => Promise<TSession>;

    /** Called to notify user of status changes (success or auth failure) */
    onNotify: (message: string) => void;

    /** Optional cleanup callback invoked when cancel() is called */
    onCleanup?: () => void;

    /**
     * Optional: override the health check function.
     * Injected for testing. Default uses axios.get to /v1/sessions.
     * Should throw on failure, resolve on success.
     */
    healthCheck?: () => Promise<void>;

    /**
     * Optional: initial delay in ms before first attempt.
     * Default: 5000ms. Set to small value in tests.
     */
    initialDelayMs?: number;

    /**
     * Optional: override retry delay calculation.
     * Default uses exponential backoff with jitter. Set to a tiny fixed delay in tests.
     */
    retryDelayMs?: (failureCount: number) => number;
}

/**
 * Handle returned by startOfflineReconnection for controlling the reconnection process.
 */
export interface OfflineReconnectionHandle<TSession> {
    /**
     * Cancel reconnection attempts and clean up timers.
     * Safe to call multiple times. Invokes onCleanup if provided.
     */
    cancel: () => void;

    /** Get the session if reconnection succeeded, null otherwise */
    getSession: () => TSession | null;

    /** Check if reconnection has succeeded (idempotent) */
    isReconnected: () => boolean;
}

/**
 * Starts background reconnection with exponential backoff.
 * Backend-agnostic: works for Claude, Codex, or any future backend.
 *
 * ## Retry Behavior
 * - **Retries are UNLIMITED** - will keep trying for hours/days/weeks
 * - Only auth failures (401) stop retrying
 * - Sessions can stay open indefinitely; server outages are expected
 *
 * ## Backoff Timing (via exponentialBackoffDelay from time.ts)
 * - Attempt 1: ~5 seconds (min delay with jitter)
 * - Attempt 5: ~30 seconds
 * - Attempt 10+: ~60 seconds (delay caps here, retries continue forever)
 * - Random jitter prevents thundering herd problem
 *
 * ## Usage Example
 * ```typescript
 * const handle = startOfflineReconnection({
 *     serverUrl: 'https://api.example.com',
 *     onReconnected: async () => {
 *         const session = await createSession();
 *         return session;
 *     },
 *     onNotify: console.log
 * });
 *
 * // Later, on cleanup:
 * handle.cancel();
 * ```
 *
 * @param config - Reconnection configuration
 * @returns Handle to control reconnection and access session
 */
export function startOfflineReconnection<TSession>(
    config: OfflineReconnectionConfig<TSession>
): OfflineReconnectionHandle<TSession> {
    // State variables
    let reconnected = false;   // Prevents duplicate reconnections
    let session: TSession | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let failureCount = 0;
    let cancelled = false;     // Prevents action after cancel()

    /**
     * Default health check: HTTP GET to /v1/sessions endpoint.
     * Uses validateStatus to treat 4xx as "server is up" (client error, not server down).
     * Only 5xx or network errors trigger retry.
     */
    const defaultHealthCheck = async () => {
        await axios.get(`${config.serverUrl}/v1/sessions`, {
            timeout: 5000,
            validateStatus: (status) => status < 500, // 4xx = server is up, 5xx = server error
            headers: {
                'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`
            }
        });
    };

    const healthCheck = config.healthCheck ?? defaultHealthCheck;
    const initialDelayMs = config.initialDelayMs ?? 5000;
    const retryDelayMs = config.retryDelayMs ?? ((count: number) => exponentialBackoffDelay(count, 5000, 60000, 10));

    /**
     * Core reconnection attempt logic.
     * Handles success, retryable errors, and permanent auth errors.
     */
    const attemptReconnect = async () => {
        // Check cancellation/success before any action (handles race conditions)
        if (reconnected || cancelled) return;

        try {
            // Step 1: Health check - verify server is reachable
            await healthCheck();

            // Re-check after async operation (handles cancel during health check)
            if (cancelled) return;

            // Step 2: Server available - perform reconnection callback
            // If onReconnected throws, we treat it as a connection error and retry
            session = await config.onReconnected();

            // Re-check after async operation (handles cancel during onReconnected)
            // Note: session is set even if cancelled - the operation completed
            if (cancelled) return;

            // Step 3: Mark success and notify user
            reconnected = true;
            config.onNotify('✅ Reconnected! Session syncing in background.');
            logger.debug('[OfflineReconnection] Successfully reconnected');
        } catch (e: unknown) {
            // Check for permanent errors that shouldn't be retried
            // 401 = auth token invalid, user needs to re-authenticate
            if (axios.isAxiosError(e) && e.response?.status === 401) {
                logger.debug('[OfflineReconnection] Authentication error, stopping retries');
                config.onNotify('❌ Authentication failed. Please re-authenticate with `idle auth`.');
                return; // Don't schedule retry - this is a permanent failure
            }

            // Retryable error: network error, 5xx, or onReconnected failure
            // Retries are UNLIMITED - only the delay caps at 60s after 10 failures
            failureCount++;
            const delay = retryDelayMs(failureCount); // Default cap is delay-only, NOT a retry limit.
            logger.debug(`[OfflineReconnection] Attempt ${failureCount} failed, retrying in ${delay}ms`);

            // Schedule next attempt (only if not cancelled)
            if (!cancelled) {
                timeoutId = setTimeout(attemptReconnect, delay);
            }
        }
    };

    // Start first attempt after initial delay
    timeoutId = setTimeout(attemptReconnect, initialDelayMs);

    // Return control handle
    return {
        cancel: () => {
            cancelled = true;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            config.onCleanup?.();
        },
        getSession: () => session,
        isReconnected: () => reconnected
    };
}

// ============================================================================
// Connection State - Simple state machine for offline status with deduplication
// ============================================================================

/** All network error codes that trigger offline mode */
export const NETWORK_ERROR_CODES = [
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED',
    'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'
] as const;

/** Check if error code indicates server unreachable */
export function isNetworkError(code: string | undefined): boolean {
    return code !== undefined && (NETWORK_ERROR_CODES as readonly string[]).includes(code);
}

/** Maps error codes to human-readable descriptions - exported for discoverability */
export const ERROR_DESCRIPTIONS: Record<string, string> = {
    // Network errors (Node.js)
    ECONNREFUSED: 'server not accepting connections',
    ENOTFOUND: 'server hostname not found',
    EAI_AGAIN: 'server hostname lookup temporarily unavailable',
    ETIMEDOUT: 'connection timed out',
    ECONNABORTED: 'connection timed out',
    ECONNRESET: 'connection reset by server',
    EPIPE: 'connection closed while sending request',
    EHOSTUNREACH: 'server host unreachable',
    ENETUNREACH: 'network unreachable',
    // HTTP errors
    '401': 'authentication failed - run `idle auth`',
    '403': 'access forbidden',
    '404': 'endpoint not found, check server deployment',
    '500': 'server internal error',
    '502': 'bad gateway',
    '503': 'service unavailable',
};

/** Failure context for accumulating multiple failures into one warning */
export type OfflineFailure = {
    operation: string;
    errorCode?: string;
};

/**
 * Coordinates offline warnings across multiple API callers.
 *
 * When server goes down, session + machine API calls both fail. This class
 * consolidates those into one clear message with all failure details, then
 * suppresses duplicates until recovery. Call recover() when back online to
 * re-enable warnings for future disconnections.
 */
class OfflineState {
    private state: 'online' | 'offline' = 'online';
    /** Report the first offline transition without retaining caller diagnostics. */
    fail(_failure: OfflineFailure): void {
        if (this.state === 'online') {
            this.state = 'offline';
            this.print();
        }
    }

    /** Reset on reconnection */
    recover(): void {
        this.state = 'online';
    }

    /** Check current state */
    isOffline(): boolean { return this.state === 'offline'; }

    /** Reset for testing - clears all state */
    reset(): void {
        this.state = 'online';
    }

    private print(): void {
        console.log('⚠️  Idle server unreachable. Offline mode is active; automatic reconnect will continue.');
    }
}

/**
 * Shared singleton for deduplicated offline transitions.
 */
export const connectionState = new OfflineState();
