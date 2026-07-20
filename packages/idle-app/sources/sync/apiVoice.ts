import {
    VoiceConversationResponseSchema,
    VoiceUsageResponseSchema,
    type VoiceConversationResponse,
    type VoiceUsageResponse,
    type VoiceTokenError,
    VoiceTokenErrorSchema,
} from '@northglass/idle-wire';
import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getIdleClientId } from './apiSocket';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';
import { randomUUID } from 'expo-crypto';

const MAX_VOICE_RESPONSE_BYTES = 64 * 1024;
const VOICE_FAILURE_MESSAGES: Record<VoiceTokenError['reason'], string> = {
    voice_not_configured: 'Voice is not configured on this relay. You can use a custom voice agent in Settings.',
    voice_check_failed: 'The relay could not verify voice availability. Check your connection and try again.',
    voice_token_failed: 'The voice provider could not start a conversation. Try again or use a custom voice agent in Settings.',
};

export type { VoiceConversationResponse, VoiceUsageResponse };

/**
 * Custom error type that carries the server's structured `reason` + `byokHint`
 * so the UI can show a targeted message (e.g. "the relay isn't configured; you
 * can use your own ElevenLabs agent in Settings → Voice"). Plain `Error` would
 * collapse this into a generic string.
 */
export class VoiceTokenFetchError extends Error {
    public readonly reason: VoiceTokenError['reason'] | 'network_error' | 'unknown';
    public readonly byokHint: boolean;
    public readonly httpStatus?: number;

    constructor(
        reason: VoiceTokenFetchError['reason'],
        message: string,
        opts: { byokHint?: boolean; httpStatus?: number } = {}
    ) {
        super(message);
        this.name = 'VoiceTokenFetchError';
        this.reason = reason;
        this.byokHint = opts.byokHint ?? false;
        this.httpStatus = opts.httpStatus;
    }
}

/**
 * Current conversation-token flow: the relay selects its configured agent and
 * mints an ElevenLabs token bound to this session. Clients intentionally cannot
 * select an agent for this flow. Structured errors keep BYOK fallbacks
 * actionable (see VoiceTokenFetchError).
 */
export async function fetchVoiceCredentials(
    credentials: AuthCredentials,
    sessionId: string
): Promise<VoiceConversationResponse> {
    const serverUrl = getServerUrl();

    let response: Response;
    try {
        response = await streamingFetch(`${serverUrl}/v1/voice/conversations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            },
            body: JSON.stringify({ requestId: randomUUID() })
        });
    } catch (e) {
        throw new VoiceTokenFetchError(
            'network_error',
            'Could not reach the relay server. Check that the relay is online and your device has network.',
            { byokHint: false }
        );
    }

    if (!response.ok) {
        // Try to parse the structured server error body for a targeted reason.
        let body: unknown;
        try {
            body = await readBoundedJsonResponse(response, MAX_VOICE_RESPONSE_BYTES);
        } catch {
            // body wasn't JSON — fall through to generic error
        }
        const parsed = VoiceTokenErrorSchema.safeParse(body);
        if (parsed.success) {
            throw new VoiceTokenFetchError(
                parsed.data.reason,
                VOICE_FAILURE_MESSAGES[parsed.data.reason],
                { byokHint: parsed.data.byokHint, httpStatus: response.status }
            );
        }
        throw new VoiceTokenFetchError(
            'unknown',
            `Voice token request failed (HTTP ${response.status}).`,
            { byokHint: false, httpStatus: response.status }
        );
    }

    return VoiceConversationResponseSchema.parse(await readBoundedJsonResponse(
        response,
        MAX_VOICE_RESPONSE_BYTES,
    ));
}

export async function fetchVoiceUsage(
    credentials: AuthCredentials
): Promise<VoiceUsageResponse> {
    const serverUrl = getServerUrl();

    const response = await streamingFetch(`${serverUrl}/v1/voice/usage`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getIdleClientId(),
        },
    });

    if (!response.ok) {
        throw new Error(`Voice usage request failed: ${response.status}`);
    }

    return VoiceUsageResponseSchema.parse(await readBoundedJsonResponse(
        response,
        MAX_VOICE_RESPONSE_BYTES,
    ));
}
