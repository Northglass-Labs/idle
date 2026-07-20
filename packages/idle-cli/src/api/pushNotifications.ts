import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import type { Metadata } from './types'
import { configuration } from '@/configuration'

export interface PushToken {
    id: string
    token: string
    createdAt: number
    updatedAt: number
}

export type SessionNotificationKind = 'done' | 'permission' | 'question'

function getSessionNotificationUrl(data: Record<string, any> | undefined): `/session/${string}` | null {
    const sessionId = data?.sessionId
    if (typeof sessionId !== 'string') {
        return null
    }

    const trimmedSessionId = sessionId.trim()
    if (!trimmedSessionId) {
        return null
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`
}

export function getSessionNotificationTitle(
    kind: SessionNotificationKind
): string {
    switch (kind) {
        case 'done':
            return "It's ready!"
        case 'permission':
            return 'Permission request'
        case 'question':
            return 'Clarification needed'
    }
}

export function getSessionNotificationBody(
    _metadata: Metadata | null | undefined
): string {
    return 'Open Idle to review this session.'
}

export function getSessionNotificationCopy(
    kind: SessionNotificationKind,
    metadata: Metadata | null | undefined
): { title: string; body: string } {
    return {
        title: getSessionNotificationTitle(kind),
        body: getSessionNotificationBody(metadata),
    }
}

export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo

    constructor(token: string, baseUrl: string = 'https://idle-api.northglass.io') {
        this.token = token
        this.baseUrl = baseUrl
        this.expo = new Expo()
    }

    /**
     * Fetch all push tokens for the authenticated user.
     * Retries up to 3 times with exponential backoff on transient errors.
     */
    async fetchPushTokens(): Promise<PushToken[]> {
        const maxAttempts = 3
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await axios.get<{ tokens: PushToken[] }>(
                    `${this.baseUrl}/v1/push-tokens`,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`
                        },
                        maxRedirects: 0,
                    }
                )

                logger.debug(`Fetched ${response.data.tokens.length} push tokens`)

                return response.data.tokens
            } catch {
                logger.debug('[PUSH] Push token fetch failed', { attempt, maxAttempts })
                if (attempt < maxAttempts) {
                    const delay = 1000 * Math.pow(2, attempt - 1) // 1s, 2s
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }
        }
        logger.debug('[PUSH] [ERROR] All push token fetch attempts failed')
        return []
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     */
    async sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
        logger.debug(`Sending ${messages.length} push notifications`)

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        if (validMessages.length === 0) {
            logger.debug('No valid Expo push tokens found')
            return
        }

        // Create chunks to respect Expo's rate limits
        const chunks = this.expo.chunkPushNotifications(validMessages)

        for (const chunk of chunks) {
            // Retry with exponential backoff for 5 minutes
            const startTime = Date.now()
            const timeout = 300000 // 5 minutes
            let attempt = 0

            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk)

                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        logger.debug('[PUSH] Some notifications failed', {
                            failedCount: errors.length,
                            ticketCount: ticketChunk.length,
                        })
                    }

                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
                        throw new Error('All push notifications in chunk failed')
                    }

                    // Success - break out of retry loop
                    break
                } catch {
                    const elapsed = Date.now() - startTime
                    if (elapsed >= timeout) {
                        logger.debug('[PUSH] Timeout reached after 5 minutes, giving up on chunk')
                        break
                    }

                    // Calculate exponential backoff delay
                    attempt++
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000) // Max 30 seconds between retries
                    const remainingTime = timeout - elapsed
                    const waitTime = Math.min(delay, remainingTime)

                    if (waitTime > 0) {
                        logger.debug(`[PUSH] Retrying in ${waitTime}ms (attempt ${attempt})`)
                        await new Promise(resolve => setTimeout(resolve, waitTime))
                    }
                }
            }
        }

        logger.debug(`Push notifications sent successfully`)
    }

    /**
     * Send a push notification to all registered devices for the user
     * @param title - Notification title
     * @param body - Notification body
     * @param data - Additional data to send with the notification
     */
    sendToAllDevices(title: string, body?: string, data?: Record<string, any>): void {
        logger.debug(`[PUSH] sendToAllDevices called (hasBody=${Boolean(body)}, hasData=${Boolean(data)})`);

        // Execute async operations without awaiting
        (async () => {
            try {
                // Fetch all push tokens
                logger.debug('[PUSH] Fetching push tokens...')
                const tokens = await this.fetchPushTokens()
                logger.debug(`[PUSH] Fetched ${tokens.length} push tokens`)

                if (tokens.length === 0) {
                    logger.debug('No push tokens found for user')
                    return
                }

                // Create messages for all tokens
                const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                    logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                    return {
                        to: token.token,
                        title,
                        body: body && body.length > 0 ? body : undefined,
                        data,
                        // Push payloads intentionally contain text and data only;
                        // local application assets are not network-deliverable media.
                        sound: 'default',
                        priority: 'high'
                    }
                })

                // Send notifications
                logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
                await this.sendPushNotifications(messages)
                logger.debug('[PUSH] Push notifications sent successfully')
            } catch {
                logger.debug('[PUSH] Device notification dispatch failed')
            }
        })()
    }

    /**
     * Routes session-event pushes through the server so it can apply
     * presence-based suppression (active desktop/web, mobile foreground).
     * Falls back to direct Expo send only when sessionId is missing — that
     * shouldn't happen for session notifications but guards against regressions.
     */
    sendSessionNotification(params: {
        kind: SessionNotificationKind
        metadata: Metadata | null | undefined
        data?: Record<string, any>
    }): void {
        const { title, body } = getSessionNotificationCopy(params.kind, params.metadata)
        const url = getSessionNotificationUrl(params.data)
        const sessionId = typeof params.data?.sessionId === 'string' ? params.data.sessionId : null
        const payloadData = {
            ...(sessionId ? { sessionId } : {}),
            kind: params.kind,
            ...(url ? { url } : {}),
        }

        if (!sessionId) {
            logger.debug('[PUSH] sendSessionNotification: missing sessionId, falling back to direct send')
            this.sendToAllDevices(title, body, payloadData)
            return
        }

        void (async () => {
            try {
                await axios.post(
                    `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/push-event`,
                    {
                        kind: params.kind,
                        title,
                        body,
                        data: { kind: params.kind },
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': `cli-daemon/${configuration.currentCliVersion}`,
                        },
                        timeout: 15000,
                        maxRedirects: 0,
                    }
                )
                logger.debug(`[PUSH] sendSessionNotification dispatched via server (kind=${params.kind})`)
            } catch {
                logger.debug('[PUSH] Session notification dispatch failed', { kind: params.kind })
            }
        })()
    }
}
