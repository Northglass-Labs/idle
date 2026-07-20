/**
 * notification handling — iOS / Android notification dismissal helpers (RN-side wrappers).
 *
 * Pure predicate lives in `notificationMatch.ts` so it's vitest-runnable
 * without RN deps. This file holds the expo-notifications wrappers.
 *
 * Tapping a notification routes the user
 * into the session but doesn't dismiss the notification itself.
 *
 * Two surfaces:
 *   - `dismissSessionNotifications(sessionId)` — called from sync.onSessionVisible.
 *     Removes any notifications keyed to that session as the user opens it.
 *   - `dismissAllNotifications()` — called from the AppState 'active' handler.
 *     Defensive blanket cleanup + badge reset.
 */

import * as Notifications from 'expo-notifications';
import { notificationMatchesSession, type NotificationLike } from './notificationMatch';

export async function dismissSessionNotifications(sessionId: string): Promise<void> {
    try {
        const presented = await Notifications.getPresentedNotificationsAsync();
        const matching = presented.filter((n) => notificationMatchesSession(n as NotificationLike, sessionId));
        await Promise.all(matching.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
    } catch (error) {
        console.warn('Failed to dismiss session notifications');
    }
}

export async function dismissAllNotifications(): Promise<void> {
    try {
        await Notifications.dismissAllNotificationsAsync();
        await Notifications.setBadgeCountAsync(0);
    } catch (error) {
        console.warn('Failed to dismiss notifications');
    }
}
