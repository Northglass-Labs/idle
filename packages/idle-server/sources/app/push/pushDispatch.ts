/**
 * Push notification dispatch.
 *
 * Single entry point: dispatchSessionEventPush — rich session-event
 * ("It's ready!", permission, question) called by CLI/daemon clients.
 *
 * Generic per-message pushes were removed: the CLI streams every assistant
 * chunk, tool_use, and tool_result as a session message, so notifying on each
 * insert produced one buzz every 10s during a turn with no useful title.
 * Connected clients still receive the realtime message update over socket;
 * only the Expo push for "new message" went away.
 *
 * Suppression: if the user has ANY non-machine client that is active
 * (connected + not backgrounded), suppress the push — they can see in-app
 * indicators (unread dots, tab title counter) instead.
 *
 * "Active" is determined by socket.data.appState:
 *   - Clients send `app-state: { state: 'active' | 'background' }` via socket.
 *   - Old clients that never send it are treated as active (connected = present).
 *   - On disconnect the socket (and its state) disappears automatically.
 */

import { db } from "@/storage/db";
import { isUserActive } from "@/app/push/focusTracker";
import { sendPushNotifications } from "@/app/push/pushSend";
import { log } from "@/utils/log";
import { MAX_PUSH_TOKENS_PER_ACCOUNT } from "@/app/push/pushTokenLimits";

async function fetchTokensAndSend(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    channelId: string;
}): Promise<void> {
    // All push tokens are mobile — web/CLI never register Expo tokens. Query and
    // slice defensively so pre-quota legacy rows cannot amplify one push event.
    const tokens = (await db.accountPushToken.findMany({
        where: { accountId: params.userId },
        orderBy: { updatedAt: 'desc' },
        take: MAX_PUSH_TOKENS_PER_ACCOUNT
    })).slice(0, MAX_PUSH_TOKENS_PER_ACCOUNT);

    if (tokens.length === 0) {
        log({ module: 'push' }, 'Push skipped: no registered tokens');
        return;
    }

    const tickets = await sendPushNotifications(
        tokens.map(t => ({
            to: t.token,
            title: params.title,
            body: params.body,
            data: params.data,
            sound: 'default' as const,
            channelId: params.channelId
        }))
    );

    let okCount = 0;
    let errorCount = 0;
    for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        if (ticket.status === 'ok') {
            okCount++;
            continue;
        }
        errorCount++;
        if (ticket.details?.error === 'DeviceNotRegistered') {
            void db.accountPushToken.deleteMany({
                where: { id: tokens[i].id }
            });
        }
    }

    if (errorCount === 0) {
        log({ module: 'push', sentCount: okCount }, 'Push sent');
    } else {
        log({ module: 'push', level: 'warn', sentCount: okCount, errorCount }, 'Push partially delivered');
    }
}

export async function dispatchSessionEventPush(params: {
    userId: string;
    sessionId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
}): Promise<void> {
    const { userId, sessionId, title, body, data } = params;

    try {
        try {
            if (await isUserActive(userId)) {
                log({ module: 'push' }, 'Push suppressed while an account client is active');
                return;
            }
        } catch (presenceError) {
            log({
                module: 'push',
                level: 'error',
                failureType: presenceError instanceof Error ? 'error' : typeof presenceError,
            }, 'Push presence check failed; continuing with delivery');
        }

        await fetchTokensAndSend({
            userId,
            sessionId,
            title,
            body,
            data: { sessionId, ...(data ?? {}) },
            channelId: 'messages'
        });
    } catch (error) {
        log({
            module: 'push',
            level: 'error',
            failureType: error instanceof Error ? 'error' : typeof error,
        }, 'Session-event push dispatch failed');
    }
}
