/**
 * Pure content formatter for the ConnectionStatusDetailSheet.
 *
 * Lives in its own file so the per-state title/blurb/primary-action logic is unit-testable
 * in plain vitest without React Native. The sheet itself (ConnectionStatusDetailSheet.tsx)
 * is a thin presentation wrapper around this output.
 *
 * Design (Variant C refined):
 *
 *   - Connected     → calm: status text only, NO primary action button (nothing for user to do)
 *   - Connecting    → in-flight: countdown text, NO primary action (auto-retry in progress, manual
 *                     retry could trigger reconnect storms)
 *   - Disconnected  → primary action "Try now" (skips backoff timer if user knows their network
 *                     just recovered)
 *   - Error         → primary action "Try now" (recovering from a definitive error)
 *
 * Plain-language framing in blurbs reassures users their messages are safe — the app auto-retries
 * and queues outgoing messages in the composer until reconnect.
 */

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface ConnectionStatusSheetContent {
    /** Color for the big dot at top of sheet. */
    dotColor: string;
    /** Title (e.g., "Connected", "Reconnecting"). */
    title: string;
    /** Plain-language explanation that reassures user. */
    blurb: string;
    /** Primary action button label, or null to hide the button (connected + connecting hide). */
    primaryActionLabel: string | null;
}

const COLORS = {
    connected: '#34C759',
    connecting: '#FF9500',
    disconnected: '#8E8E93',
    error: '#FF453A',
} as const;

export function buildConnectionStatusSheetContent(args: {
    state: ConnectionState;
    nextRetryInSeconds?: number;
}): ConnectionStatusSheetContent {
    const { state, nextRetryInSeconds } = args;

    if (state === 'connected') {
        return {
            dotColor: COLORS.connected,
            title: 'Connected',
            blurb: 'Your messages send instantly.',
            primaryActionLabel: null,
        };
    }

    if (state === 'connecting') {
        return {
            dotColor: COLORS.connecting,
            title: 'Reconnecting',
            blurb:
                nextRetryInSeconds !== undefined
                    ? `Idle will retry automatically in ${nextRetryInSeconds}s. Your messages stay in the composer until reconnect.`
                    : 'Idle is retrying automatically. Your messages stay in the composer until reconnect.',
            primaryActionLabel: null,
        };
    }

    if (state === 'disconnected') {
        return {
            dotColor: COLORS.disconnected,
            title: 'Offline',
            blurb:
                'Anything you type stays in the composer until the connection comes back. Idle will keep retrying in the background.',
            primaryActionLabel: 'Try now',
        };
    }

    // error
    return {
        dotColor: COLORS.error,
        title: 'Connection failed',
        blurb:
            'Idle couldn\'t reach the relay. It will keep retrying automatically. Tap below to retry right now, or open Show details to see why.',
        primaryActionLabel: 'Try now',
    };
}
