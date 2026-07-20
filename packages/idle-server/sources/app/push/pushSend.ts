/**
 * Sends push notifications via Expo's HTTP Push API.
 * Direct HTTP POST — no expo-server-sdk dependency needed.
 * Batches up to 100 tokens per request (Expo's documented limit).
 */

import { z } from 'zod';
import { readBoundedJsonResponse } from '@/utils/boundedResponse';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;
const EXPO_RESPONSE_MAX_BYTES = 256 * 1024;
const EXPO_FETCH_TIMEOUT_MS = 15_000;

const PushTicketSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        id: z.string().min(1).max(1024),
    }).strict(),
    z.object({
        status: z.literal('error'),
        message: z.string().min(1).max(8192),
        details: z.object({
            error: z.string().min(1).max(256).optional(),
        }).strict().optional(),
    }).strict(),
]);
const ExpoPushResponseSchema = z.object({
    data: z.array(PushTicketSchema).max(BATCH_SIZE),
}).strict();

export interface PushMessage {
    to: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    sound?: 'default' | null;
    badge?: number;
    channelId?: string;
}

export interface PushTicket {
    status: 'ok' | 'error';
    id?: string;
    message?: string;
    details?: { error?: string };
}

export async function sendPushNotifications(messages: PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) {
        return [];
    }

    const tickets: PushTicket[] = [];

    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(EXPO_FETCH_TIMEOUT_MS),
            });

            if (!response.ok) {
                tickets.push(...batch.map(() => ({
                    status: 'error' as const,
                    message: `HTTP ${response.status}`
                })));
                continue;
            }

            const result = await readBoundedJsonResponse(
                response,
                EXPO_RESPONSE_MAX_BYTES,
                ExpoPushResponseSchema,
            );
            if (result.data.length !== batch.length) {
                throw new Error('Unexpected Expo push ticket count');
            }
            tickets.push(...result.data);
        } catch {
            tickets.push(...batch.map(() => ({
                status: 'error' as const,
                message: 'Network error'
            })));
        }
    }

    return tickets;
}
