import * as z from 'zod';

const MAX_VOICE_TOKEN_CHARS = 16 * 1024;
const MAX_VOICE_USAGE_SECONDS = 10 * 366 * 24 * 60 * 60;
const VoiceUsageSecondsSchema = z.number().int().nonnegative().max(MAX_VOICE_USAGE_SECONDS);
const VoiceCountSchema = z.number().int().nonnegative().max(10_000);
const VoiceAgentIdSchema = z.string().min(1).max(64).regex(/^agent_[A-Za-z0-9]+$/);
const VoiceConversationIdSchema = z.string().min(1).max(128).regex(/^conv_[A-Za-z0-9]+$/);
const VoiceUserIdSchema = z.string().min(1).max(64).regex(/^u_[A-Za-z0-9_-]+$/);
const VoiceProviderTokenSchema = z.string().min(1).max(MAX_VOICE_TOKEN_CHARS);

// Relay-funded conversation-token protocol used by current clients.

export const VoiceConversationGrantedSchema = z.object({
    allowed: z.literal(true),
    conversationToken: VoiceProviderTokenSchema,
    conversationId: VoiceConversationIdSchema,
    agentId: VoiceAgentIdSchema,
    elevenUserId: VoiceUserIdSchema,
    usedSeconds: VoiceUsageSecondsSchema,
    limitSeconds: VoiceUsageSecondsSchema,
}).strict();

export const VoiceConversationDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_hard_limit_reached', 'subscription_required', 'voice_conversation_limit_reached']),
    usedSeconds: VoiceUsageSecondsSchema,
    limitSeconds: VoiceUsageSecondsSchema,
    agentId: VoiceAgentIdSchema,
}).strict();

export const VoiceConversationResponseSchema = z.discriminatedUnion('allowed', [
    VoiceConversationGrantedSchema,
    VoiceConversationDeniedSchema,
]);

export type VoiceConversationResponse = z.infer<typeof VoiceConversationResponseSchema>;

export const VoiceUsageResponseSchema = z.object({
    usedSeconds: VoiceUsageSecondsSchema,
    limitSeconds: VoiceUsageSecondsSchema,
    conversationCount: VoiceCountSchema,
    conversationLimit: VoiceCountSchema,
    elevenUserId: VoiceUserIdSchema,
}).strict();

export type VoiceUsageResponse = z.infer<typeof VoiceUsageResponseSchema>;

// Compatibility contract for released clients that call /v1/voice/token.
// Keep this shape aligned with the server for the supported-client window.

export const VoiceTokenAllowedSchema = z.object({
    allowed: z.literal(true),
    token: VoiceProviderTokenSchema,
    agentId: VoiceAgentIdSchema,
    elevenUserId: VoiceUserIdSchema,
    usedSeconds: VoiceUsageSecondsSchema,
    limitSeconds: VoiceUsageSecondsSchema,
}).strict();

export const VoiceTokenDeniedSchema = z.object({
    allowed: z.literal(false),
    reason: z.enum(['voice_limit_reached', 'subscription_required']),
    usedSeconds: VoiceUsageSecondsSchema,
    limitSeconds: VoiceUsageSecondsSchema,
    agentId: VoiceAgentIdSchema,
}).strict();

export const VoiceTokenResponseSchema = z.discriminatedUnion('allowed', [
    VoiceTokenAllowedSchema,
    VoiceTokenDeniedSchema,
]);

export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponseSchema>;

/**
 * Structured error reasons returned in 500 bodies from the voice token/
 * conversation-token endpoint. Client uses these to show targeted error
 * messages and suggest the BYOK (Bring Your Own Key) ElevenLabs pattern
 * when a deployment cannot mint relay-funded credentials.
 */
export const VoiceTokenErrorReasonSchema = z.enum([
    'voice_not_configured',
    'voice_check_failed',
    'voice_token_failed',
]);

export type VoiceTokenErrorReason = z.infer<typeof VoiceTokenErrorReasonSchema>;

export const VoiceTokenErrorSchema = z.object({
    error: z.string().min(1).max(8192),
    reason: VoiceTokenErrorReasonSchema,
    /**
     * When true, the client should suggest the BYOK pattern (set
     * voiceCustomAgentId + voiceBypassToken in Settings → Voice) so the
     * user can connect directly to their own ElevenLabs account.
     */
    byokHint: z.boolean(),
}).strict();

export type VoiceTokenError = z.infer<typeof VoiceTokenErrorSchema>;
