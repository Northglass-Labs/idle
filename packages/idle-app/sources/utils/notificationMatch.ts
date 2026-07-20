/**
 * Pure predicate for matching notifications to sessions. No RN deps.
 *
 * Extracted from notificationDismiss.ts so it's vitest-runnable without
 * pulling in expo-notifications.
 */

export interface NotificationLike {
    request: {
        identifier: string;
        content: {
            data?: unknown;
        };
    };
}

/**
 * Does this notification belong to the given session?
 * Looks for `data.sessionId` matching exactly. Defensive against missing
 * / non-object / wrong-typed data payloads.
 */
export function notificationMatchesSession(notification: NotificationLike, sessionId: string): boolean {
    const data = notification.request.content.data;
    if (!data || typeof data !== 'object') return false;
    const obj = data as Record<string, unknown>;
    return obj.sessionId === sessionId;
}
