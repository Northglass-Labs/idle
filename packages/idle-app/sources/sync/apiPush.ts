import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getIdleClientId } from './apiSocket';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';

const MAX_PUSH_RESPONSE_BYTES = 256 * 1024;
const TimestampSchema = z.number().int().nonnegative().max(253_402_300_799_000);
const SuccessResponseSchema = z.object({ success: z.literal(true) }).strict();

const PushTokenSchema = z.object({
    id: z.string().min(1).max(64),
    token: z.string().min(1).max(1_024),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
}).strict();

const PushTokenListResponseSchema = z.object({
    tokens: z.array(PushTokenSchema).max(20),
}).strict();

export type PushToken = z.infer<typeof PushTokenSchema>;

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            },
            body: JSON.stringify({ token })
        });

        if (!response.ok) {
            throw new Error(`Failed to register push token: ${response.status}`);
        }

        SuccessResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_PUSH_RESPONSE_BYTES,
        ));
    });
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    return backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch push tokens: ${response.status}`);
        }

        const data = await readBoundedJsonResponse(response, MAX_PUSH_RESPONSE_BYTES);
        return PushTokenListResponseSchema.parse(data).tokens;
    });
}

export async function unregisterPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/push-tokens/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to unregister push token: ${response.status}`);
        }

        SuccessResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_PUSH_RESPONSE_BYTES,
        ));
    });
}
