import { z } from "zod";
import * as crypto from "crypto";
import { VoiceConversationResponseSchema, VoiceUsageResponseSchema, VoiceTokenResponseSchema, VoiceTokenErrorSchema, type VoiceTokenErrorReason } from "@northglass/idle-wire";
import { type Fastify } from "../types";
import { log } from "@/utils/log";
import { IdSchema } from "@/app/api/routes/_schemas";
import { readBoundedJsonResponse } from "@/utils/boundedResponse";
import { getRuntimeMasterSecret } from "@/utils/runtimeMasterSecret";
import {
    bindVoiceCapacityReservation,
    releaseVoiceCapacityReservation,
    reserveVoiceCapacity,
    VOICE_MAX_CONVERSATIONS,
} from "@/app/voice/voiceCapacity";

/**
 * Map a server-side voice failure to a structured 500 body so the client can
 * show a targeted message (and surface the BYOK hint when the operator hasn't
 * configured an ElevenLabs key). Every failure path uses the same bounded
 * public shape and keeps provider diagnostics on the server side.
 */
function voiceError(reason: VoiceTokenErrorReason, byokHint: boolean = true, humanMessage?: string) {
    const messages: Record<VoiceTokenErrorReason, string> = {
        voice_not_configured: 'Server voice is not configured. Use your own ElevenLabs agent in Settings → Voice → Custom agent ID, then enable "Bypass server token".',
        voice_check_failed:   'Could not reach ElevenLabs to check usage limits. Check your network and try again.',
        voice_token_failed:   'ElevenLabs rejected the conversation token request. Try again, or use your own agent via Settings → Voice.',
    };
    return {
        error: humanMessage ?? messages[reason],
        reason,
        byokHint,
    };
}

const VOICE_FREE_LIMIT_SECONDS = 3600;  // One hour per rolling 30-day window.
const VOICE_HARD_LIMIT_SECONDS = 18000; // Five-hour absolute cap per rolling window.
const ELEVEN_LABS_API = "https://api.elevenlabs.io/v1/convai";
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000;
const ELEVEN_LABS_CONVERSATIONS_MAX_BYTES = 512 * 1024;
const ELEVEN_LABS_TOKEN_MAX_BYTES = 32 * 1024;
const REVENUECAT_ENTITLEMENTS_MAX_BYTES = 64 * 1024;
const VOICE_TOKEN_START_WINDOW_SECONDS = 60 * 60;
const VOICE_ACCOUNTING_GRACE_SECONDS = 24 * 60 * 60;
const ElevenLabsAgentIdSchema = IdSchema.regex(/^agent_[A-Za-z0-9]+$/);
const VoiceRequestIdSchema = z.string().uuid();
const VoiceMaxConversationSecondsSchema = z.coerce.number().int().min(1).max(60 * 60);

const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ElevenLabsConversationSummarySchema = z.object({
    agent_id: IdSchema,
    agent_name: z.string().max(256).optional(),
    conversation_id: IdSchema,
    start_time_unix_secs: NonnegativeSafeIntegerSchema,
    call_duration_secs: NonnegativeSafeIntegerSchema.max(31 * 24 * 60 * 60),
    message_count: NonnegativeSafeIntegerSchema.max(1_000_000),
    status: z.enum(['in-progress', 'processing', 'done', 'failed']),
    call_successful: z.enum(['success', 'failure', 'unknown']),
}).strict();
const ElevenLabsConversationsResponseSchema = z.object({
    conversations: z.array(ElevenLabsConversationSummarySchema).max(VOICE_MAX_CONVERSATIONS),
    next_cursor: z.string().min(1).max(1024).optional(),
    has_more: z.boolean(),
}).strict();
const ElevenLabsTokenEnvelopeSchema = z.object({
    token: z.string().min(1).max(16 * 1024),
}).strict();
const ElevenLabsTokenPayloadSchema = z.object({
    exp: NonnegativeSafeIntegerSchema,
    video: z.object({
        room: z.string().min(1).max(2048),
    }).passthrough(),
}).passthrough();
const RevenueCatEntitlementsResponseSchema = z.object({
    object: z.literal('list'),
    items: z.array(z.object({
        object: z.literal('customer.active_entitlement'),
        entitlement_id: z.string().min(1).max(255),
        expires_at: NonnegativeSafeIntegerSchema.nullable(),
    }).strict()).max(100),
    next_page: z.string().max(2048).nullable(),
    url: z.string().min(1).max(2048),
}).strict();

function getVoiceServerConfig(): {
    apiKey: string;
    agentId: string;
    maxConversationSeconds: number;
} | null {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = ElevenLabsAgentIdSchema.safeParse(process.env.ELEVENLABS_AGENT_ID);
    const maxConversationSeconds = VoiceMaxConversationSecondsSchema.safeParse(
        process.env.ELEVENLABS_MAX_CONVERSATION_SECONDS,
    );
    if (!apiKey || !agentId.success || !maxConversationSeconds.success) {
        return null;
    }
    return {
        apiKey,
        agentId: agentId.data,
        maxConversationSeconds: maxConversationSeconds.data,
    };
}

function conversationTokenUrl(agentId: string, participantName?: string): URL {
    const url = new URL(`${ELEVEN_LABS_API}/conversation/token`);
    url.searchParams.set('agent_id', agentId);
    if (participantName) {
        url.searchParams.set('participant_name', participantName);
    }
    return url;
}

/**
 * Derives a stable pseudonymous ElevenLabs user ID from the Idle user ID.
 * Uses HMAC-SHA256 with the server master secret so the mapping is consistent
 * across sessions but the raw Idle ID is never exposed to ElevenLabs.
 */
function deriveElevenUserId(idleUserId: string): string {
    const hmac = crypto.createHmac("sha256", getRuntimeMasterSecret());
    hmac.update(idleUserId);
    const digest = hmac.digest();
    const base64url = digest
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `u_${base64url}`;
}

/**
 * Get a user's voice usage in seconds over the last 30 days.
 * Queries ElevenLabs directly by user_id (set via participant_name on token mint).
 * ElevenLabs is the source of truth — no local DB needed.
 *
 * Returns bounded usage plus completed IDs used to reconcile durable leases.
 */
async function getVoiceUsage(
    elevenLabsApiKey: string,
    elevenUserId: string,
): Promise<{
    usedSeconds: number;
    conversationCount: number;
    completedProviderConversationIds: string[];
}> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

    // Query across all agents — usage is per-user, not per-agent
    const res = await fetch(
        `${ELEVEN_LABS_API}/conversations?user_id=${elevenUserId}&created_after=${thirtyDaysAgo}&page_size=100`,
        {
            headers: { "xi-api-key": elevenLabsApiKey },
            signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
        }
    );

    if (!res.ok) {
        log({ module: 'voice', statusCode: res.status }, 'Voice usage provider request failed');
        throw new Error('ElevenLabs usage lookup failed');
    }

    const data = await readBoundedJsonResponse(
        res,
        ELEVEN_LABS_CONVERSATIONS_MAX_BYTES,
        ElevenLabsConversationsResponseSchema,
    );

    const conversations = data.conversations;
    let usedSeconds = 0;
    for (const c of conversations) {
        usedSeconds += c.call_duration_secs ?? 0;
    }
    return {
        usedSeconds,
        conversationCount: conversations.length,
        completedProviderConversationIds: conversations
            .filter((conversation) => (
                conversation.status === 'done' || conversation.status === 'failed'
            ))
            .map((conversation) => conversation.conversation_id),
    };
}

/**
 * Checks whether the user has an active entitlement via RevenueCat (V2 API).
 * Subscription integration is optional. A deployment without complete
 * RevenueCat configuration grants only the relay's included voice allowance.
 */
async function hasActiveSubscription(userId: string): Promise<boolean> {
    const revenueCatApiKey = process.env.REVENUECAT_API_KEY;
    const revenueCatProjectId = process.env.REVENUECAT_PROJECT_ID;
    if (!revenueCatApiKey || !revenueCatProjectId) {
        log({ module: "voice" }, "RevenueCat not configured, treating as no subscription");
        return false;
    }

    try {
        const response = await fetch(
            `https://api.revenuecat.com/v2/projects/${encodeURIComponent(revenueCatProjectId)}/customers/${encodeURIComponent(userId)}/active_entitlements`,
            {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${revenueCatApiKey}`,
                },
                signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
            }
        );
        if (!response.ok) {
            log({ module: 'voice', statusCode: response.status }, 'Voice entitlement provider request failed');
            return false;
        }
        const data = await readBoundedJsonResponse(
            response,
            REVENUECAT_ENTITLEMENTS_MAX_BYTES,
            RevenueCatEntitlementsResponseSchema,
        );
        return data.items.length > 0;
    } catch {
        return false;
    }
}

type VoiceCapacityAuthorization = {
    usedSeconds: number;
    limitSeconds: number;
    entitlementActive: boolean;
    capacity: Awaited<ReturnType<typeof reserveVoiceCapacity>>;
};

async function authorizeVoiceCapacity(input: {
    accountId: string;
    requestId: string;
    elevenLabsApiKey: string;
    elevenUserId: string;
    maxConversationSeconds: number;
}): Promise<VoiceCapacityAuthorization> {
    const [usage, entitlementActive] = await Promise.all([
        getVoiceUsage(input.elevenLabsApiKey, input.elevenUserId),
        hasActiveSubscription(input.accountId),
    ]);
    const limitSeconds = entitlementActive
        ? VOICE_HARD_LIMIT_SECONDS
        : VOICE_FREE_LIMIT_SECONDS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (
        VOICE_TOKEN_START_WINDOW_SECONDS
        + input.maxConversationSeconds
        + VOICE_ACCOUNTING_GRACE_SECONDS
    ) * 1_000);

    const capacity = await reserveVoiceCapacity({
        accountId: input.accountId,
        requestId: input.requestId,
        providerUsedSeconds: usage.usedSeconds,
        providerConversationCount: usage.conversationCount,
        completedProviderConversationIds: usage.completedProviderConversationIds,
        limitSeconds,
        reservationSeconds: input.maxConversationSeconds,
        expiresAt,
        now,
    });

    return {
        usedSeconds: usage.usedSeconds,
        limitSeconds,
        entitlementActive,
        capacity,
    };
}

function parseElevenLabsConversationToken(
    token: string,
    maxConversationSeconds: number,
): { conversationId: string; reservationExpiresAt: Date } {
    const segments = token.split('.');
    if (segments.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(segments[1] ?? '')) {
        throw new Error('Invalid voice provider token');
    }

    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    } catch {
        throw new Error('Invalid voice provider token');
    }
    const parsed = ElevenLabsTokenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
        throw new Error('Invalid voice provider token');
    }

    const nowMs = Date.now();
    const tokenExpiresAtMs = parsed.data.exp * 1_000;
    if (
        tokenExpiresAtMs <= nowMs
        || tokenExpiresAtMs > nowMs + VOICE_TOKEN_START_WINDOW_SECONDS * 1_000
    ) {
        throw new Error('Invalid voice provider token lifetime');
    }

    const conversationId = parsed.data.video.room.match(/(conv_[A-Za-z0-9]+)/)?.[1];
    if (!conversationId || !IdSchema.safeParse(conversationId).success) {
        throw new Error('Voice provider token has no bounded conversation identifier');
    }

    return {
        conversationId,
        reservationExpiresAt: new Date(tokenExpiresAtMs + (
            maxConversationSeconds + VOICE_ACCOUNTING_GRACE_SECONDS
        ) * 1_000),
    };
}

async function mintAndBindVoiceToken(input: {
    accountId: string;
    reservationId: string;
    elevenLabsApiKey: string;
    elevenUserId: string;
    agentId: string;
    maxConversationSeconds: number;
}): Promise<
    | { kind: 'issued'; token: string; conversationId: string }
    | { kind: 'rejected' }
> {
    const response = await fetch(
        conversationTokenUrl(input.agentId, input.elevenUserId),
        {
            method: 'GET',
            headers: {
                'xi-api-key': input.elevenLabsApiKey,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
        },
    );

    if (!response.ok) {
        log({ module: 'voice', statusCode: response.status }, 'Voice token provider request failed');
        try {
            await releaseVoiceCapacityReservation({
                accountId: input.accountId,
                reservationId: input.reservationId,
            });
        } catch {
            // The provider definitely rejected the mint. A failed cleanup is
            // still safe because the lease expires conservatively.
            log({ module: 'voice' }, 'Voice capacity lease cleanup failed');
        }
        return { kind: 'rejected' };
    }

    const { token } = await readBoundedJsonResponse(
        response,
        ELEVEN_LABS_TOKEN_MAX_BYTES,
        ElevenLabsTokenEnvelopeSchema,
    );
    const parsedToken = parseElevenLabsConversationToken(
        token,
        input.maxConversationSeconds,
    );
    const bound = await bindVoiceCapacityReservation({
        accountId: input.accountId,
        reservationId: input.reservationId,
        providerConversationId: parsedToken.conversationId,
        expiresAt: parsedToken.reservationExpiresAt,
    });
    if (!bound) {
        throw new Error('Voice capacity lease could not be bound');
    }

    return {
        kind: 'issued',
        token,
        conversationId: parsedToken.conversationId,
    };
}

export function voiceRoutes(app: Fastify) {
    // Current WebRTC flow: the relay mints a token for its configured agent.
    app.post('/v1/voice/conversations', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                // Accepted only so already-shipped clients remain compatible.
                // The server never uses this deprecated client-selected value.
                agentId: IdSchema.optional(),
                requestId: VoiceRequestIdSchema.optional(),
            }),
            response: {
                200: VoiceConversationResponseSchema,
                500: VoiceTokenErrorSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        log({ module: 'voice' }, 'Voice conversation-token request received');

        const voiceConfig = getVoiceServerConfig();
        if (!voiceConfig) {
            log({ module: 'voice' }, 'Server voice configuration is incomplete');
            return reply.code(500).send(voiceError('voice_not_configured', true));
        }
        const {
            apiKey: elevenLabsApiKey,
            agentId,
            maxConversationSeconds,
        } = voiceConfig;

        const elevenUserId = deriveElevenUserId(userId);
        const requestId = request.body.requestId ?? crypto.randomUUID();
        let authorization: VoiceCapacityAuthorization;
        try {
            authorization = await authorizeVoiceCapacity({
                accountId: userId,
                requestId,
                elevenLabsApiKey,
                elevenUserId,
                maxConversationSeconds,
            });
        } catch {
            log({ module: 'voice' }, 'Failed to reserve voice capacity');
            return reply.code(500).send(voiceError('voice_check_failed', false));
        }

        if (authorization.capacity.kind === 'conversation-limit') {
            return reply.send({
                allowed: false as const,
                reason: 'voice_conversation_limit_reached' as const,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: authorization.limitSeconds,
                agentId,
            });
        }
        if (authorization.capacity.kind === 'duration-limit') {
            return reply.send({
                allowed: false as const,
                reason: authorization.entitlementActive
                    ? 'voice_hard_limit_reached' as const
                    : 'subscription_required' as const,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: authorization.limitSeconds,
                agentId,
            });
        }
        if (authorization.capacity.kind === 'duplicate') {
            log({ module: 'voice' }, 'Duplicate voice token coordinate rejected');
            return reply.code(500).send(voiceError('voice_token_failed', false));
        }

        try {
            const minted = await mintAndBindVoiceToken({
                accountId: userId,
                reservationId: authorization.capacity.reservation.id,
                elevenLabsApiKey,
                elevenUserId,
                agentId,
                maxConversationSeconds,
            });
            if (minted.kind === 'rejected') {
                return reply.code(500).send(voiceError('voice_token_failed', true));
            }

            log({ module: 'voice' }, 'Voice conversation token issued');
            return reply.send({
                allowed: true as const,
                conversationToken: minted.token,
                conversationId: minted.conversationId,
                agentId,
                elevenUserId,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: authorization.limitSeconds,
            });
        } catch {
            log({ module: 'voice' }, 'ElevenLabs conversation token request failed');
            return reply.code(500).send(voiceError('voice_token_failed', true));
        }
    });

    /**
     * Returns voice usage for the authenticated user over the last 30 days.
     * Queries ElevenLabs directly — no local DB needed.
     */
    app.get('/v1/voice/usage', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: VoiceUsageResponseSchema,
                500: z.object({ error: z.string().min(1).max(8192) }).strict(),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
        if (!elevenLabsApiKey) {
            return reply.code(500).send({ error: 'Server voice is not configured' });
        }

        const elevenUserId = deriveElevenUserId(userId);
        const hardLimitSeconds = VOICE_HARD_LIMIT_SECONDS;

        try {
            const [{ usedSeconds, conversationCount }, subscribed] = await Promise.all([
                getVoiceUsage(elevenLabsApiKey, elevenUserId),
                hasActiveSubscription(userId),
            ]);
            return reply.send({
                usedSeconds,
                limitSeconds: subscribed ? hardLimitSeconds : VOICE_FREE_LIMIT_SECONDS,
                conversationCount,
                conversationLimit: VOICE_MAX_CONVERSATIONS,
                elevenUserId,
            });
        } catch {
            log({ module: 'voice' }, 'Failed to get voice usage');
            return reply.code(500).send({ error: 'Failed to get voice usage' });
        }
    });

    /**
     * Compatibility endpoint for released clients that request the token-only
     * response contract. It enforces the same authorization ceilings as the
     * current conversation endpoint.
     */
    app.post('/v1/voice/token', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                // Accepted only so already-shipped clients remain compatible.
                // The server never uses this deprecated client-selected value.
                agentId: IdSchema.optional(),
                requestId: VoiceRequestIdSchema.optional(),
            }),
            response: {
                200: VoiceTokenResponseSchema,
                500: VoiceTokenErrorSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;

        log({ module: 'voice' }, 'Compatibility voice token request received');

        const voiceConfig = getVoiceServerConfig();
        if (!voiceConfig) {
            log({ module: 'voice' }, 'Server voice configuration is incomplete');
            return reply.code(500).send(voiceError('voice_not_configured', true));
        }
        const {
            apiKey: elevenLabsApiKey,
            agentId,
            maxConversationSeconds,
        } = voiceConfig;

        const elevenUserId = deriveElevenUserId(userId);
        const requestId = request.body.requestId ?? crypto.randomUUID();
        let authorization: VoiceCapacityAuthorization;
        try {
            authorization = await authorizeVoiceCapacity({
                accountId: userId,
                requestId,
                elevenLabsApiKey,
                elevenUserId,
                maxConversationSeconds,
            });
        } catch {
            log({ module: 'voice' }, 'Failed to reserve voice capacity');
            return reply.code(500).send(voiceError('voice_check_failed', false));
        }

        if (authorization.capacity.kind === 'conversation-limit') {
            return reply.send({
                allowed: false as const,
                reason: 'voice_limit_reached' as const,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: VOICE_HARD_LIMIT_SECONDS,
                agentId,
            });
        }
        if (authorization.capacity.kind === 'duration-limit') {
            return reply.send({
                allowed: false as const,
                reason: 'voice_limit_reached' as const,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: authorization.usedSeconds >= VOICE_HARD_LIMIT_SECONDS
                    ? VOICE_HARD_LIMIT_SECONDS
                    : authorization.limitSeconds,
                agentId,
            });
        }
        if (authorization.capacity.kind === 'duplicate') {
            log({ module: 'voice' }, 'Duplicate compatibility voice token coordinate rejected');
            return reply.code(500).send(voiceError('voice_token_failed', false));
        }

        try {
            const minted = await mintAndBindVoiceToken({
                accountId: userId,
                reservationId: authorization.capacity.reservation.id,
                elevenLabsApiKey,
                elevenUserId,
                agentId,
                maxConversationSeconds,
            });
            if (minted.kind === 'rejected') {
                return reply.code(500).send(voiceError('voice_token_failed', true));
            }

            log({ module: 'voice' }, 'Compatibility voice token issued');
            return reply.send({
                allowed: true as const,
                token: minted.token,
                agentId,
                elevenUserId,
                usedSeconds: authorization.usedSeconds,
                limitSeconds: authorization.limitSeconds,
            });
        } catch {
            log({ module: 'voice' }, 'ElevenLabs token request failed');
            return reply.code(500).send(voiceError('voice_token_failed', true));
        }
    });
}
