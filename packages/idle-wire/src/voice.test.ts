import { describe, expect, it } from 'vitest';
import {
    VoiceConversationResponseSchema,
    VoiceTokenErrorSchema,
    VoiceTokenResponseSchema,
    VoiceUsageResponseSchema,
} from './voice';

const grantedConversation = {
    allowed: true as const,
    conversationToken: 'header.payload.signature',
    conversationId: 'conv_abc123',
    agentId: 'agent_abc123',
    elevenUserId: 'u_abc123',
    usedSeconds: 120,
    limitSeconds: 3_600,
};

describe('voice protocol response boundaries', () => {
    it('accepts current and compatibility response shapes', () => {
        expect(VoiceConversationResponseSchema.parse(grantedConversation)).toEqual(grantedConversation);
        expect(VoiceTokenResponseSchema.parse({
            allowed: true,
            token: 'header.payload.signature',
            agentId: 'agent_abc123',
            elevenUserId: 'u_abc123',
            usedSeconds: 120,
            limitSeconds: 3_600,
        })).toMatchObject({ allowed: true });
        expect(VoiceUsageResponseSchema.parse({
            usedSeconds: 120,
            limitSeconds: 3_600,
            conversationCount: 2,
            conversationLimit: 100,
            elevenUserId: 'u_abc123',
        })).toMatchObject({ conversationCount: 2 });
    });

    it.each([
        { schema: VoiceConversationResponseSchema, value: { ...grantedConversation, internalNote: 'private' } },
        {
            schema: VoiceUsageResponseSchema,
            value: {
                usedSeconds: 1,
                limitSeconds: 2,
                conversationCount: 1,
                conversationLimit: 100,
                elevenUserId: 'u_abc123',
                providerPayload: {},
            },
        },
        {
            schema: VoiceTokenErrorSchema,
            value: {
                error: 'Voice unavailable',
                reason: 'voice_token_failed',
                byokHint: true,
                diagnostic: 'provider detail',
            },
        },
    ])('rejects unknown response fields', ({ schema, value }) => {
        expect(schema.safeParse(value).success).toBe(false);
    });

    it.each([
        { field: 'conversationToken', value: 'x'.repeat(16 * 1024 + 1) },
        { field: 'conversationId', value: `conv_${'x'.repeat(128)}` },
        { field: 'agentId', value: `agent_${'x'.repeat(64)}` },
        { field: 'elevenUserId', value: `u_${'x'.repeat(64)}` },
    ])('rejects an oversized $field', ({ field, value }) => {
        expect(VoiceConversationResponseSchema.safeParse({
            ...grantedConversation,
            [field]: value,
        }).success).toBe(false);
    });

    it.each([
        { field: 'usedSeconds', value: -1 },
        { field: 'usedSeconds', value: Number.NaN },
        { field: 'limitSeconds', value: Number.POSITIVE_INFINITY },
        { field: 'conversationCount', value: 1.5 },
        { field: 'conversationLimit', value: 10_001 },
    ])('rejects invalid bounded numeric field $field', ({ field, value }) => {
        const usage = {
            usedSeconds: 120,
            limitSeconds: 3_600,
            conversationCount: 2,
            conversationLimit: 100,
            elevenUserId: 'u_abc123',
            [field]: value,
        };
        expect(VoiceUsageResponseSchema.safeParse(usage).success).toBe(false);
    });

    it('bounds public error text', () => {
        expect(VoiceTokenErrorSchema.safeParse({
            error: 'x'.repeat(8_193),
            reason: 'voice_token_failed',
            byokHint: true,
        }).success).toBe(false);
    });
});
