import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    bindVoiceCapacityReservationMock,
    logMock,
    releaseVoiceCapacityReservationMock,
    reserveVoiceCapacityMock,
} = vi.hoisted(() => ({
    bindVoiceCapacityReservationMock: vi.fn(),
    logMock: vi.fn(),
    releaseVoiceCapacityReservationMock: vi.fn(),
    reserveVoiceCapacityMock: vi.fn(),
}));

vi.mock('../../../utils/log', () => ({ log: logMock }));
vi.mock('../../voice/voiceCapacity', () => ({
    bindVoiceCapacityReservation: bindVoiceCapacityReservationMock,
    releaseVoiceCapacityReservation: releaseVoiceCapacityReservationMock,
    reserveVoiceCapacity: reserveVoiceCapacityMock,
    VOICE_MAX_CONVERSATIONS: 100,
}));

import { voiceRoutes } from './voiceRoutes';
import { setRuntimeMasterSecret } from '../../../utils/runtimeMasterSecret';

const SERVER_AGENT_ID = 'agent_serverowned123';
const CLIENT_AGENT_ID = 'agent_attackerchosen456';
const USER_ID = 'user_sensitive_identifier_789';
const CONVERSATION_ID = 'conv_sensitiveidentifier012';
const CONVERSATION_TOKEN = jwtWithRoom(CONVERSATION_ID);

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = USER_ID;
    });
    voiceRoutes(typed);
    await typed.ready();
    return typed;
}

function jwtWithRoom(room: string): string {
    const payload = Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1_000) + 600,
        video: { room },
    })).toString('base64url');
    return `header.${payload}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function conversationSummary(callDurationSecs: number, index = 0): Record<string, unknown> {
    return {
        agent_id: SERVER_AGENT_ID,
        agent_name: 'Idle',
        conversation_id: `conv_test${index}`,
        start_time_unix_secs: 1_700_000_000 + index,
        call_duration_secs: callDurationSecs,
        message_count: 1,
        status: 'done',
        call_successful: 'success',
    };
}

function upstreamFetch(input: string | URL | Request): Promise<Response> {
    const url = String(input);
    if (url.includes('/conversations?')) {
        return Promise.resolve(jsonResponse({ conversations: [], has_more: false }));
    }
    if (url.includes('/conversation/token?')) {
        return Promise.resolve(jsonResponse({ token: CONVERSATION_TOKEN }));
    }
    throw new Error(`Unexpected upstream request: ${new URL(url).pathname}`);
}

describe('voice relay agent trust boundary', () => {
    let app: Fastify;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        setRuntimeMasterSecret('b7'.repeat(32));
        process.env.ELEVENLABS_API_KEY = 'test-api-key';
        process.env.ELEVENLABS_AGENT_ID = SERVER_AGENT_ID;
        process.env.ELEVENLABS_MAX_CONVERSATION_SECONDS = '60';
        reserveVoiceCapacityMock.mockReset();
        bindVoiceCapacityReservationMock.mockReset();
        releaseVoiceCapacityReservationMock.mockReset();
        reserveVoiceCapacityMock.mockImplementation(async (input: {
            limitSeconds: number;
            providerConversationCount: number;
            providerUsedSeconds: number;
            requestId: string;
            reservationSeconds: number;
        }) => {
            if (input.providerConversationCount >= 100) return { kind: 'conversation-limit' };
            if (input.providerUsedSeconds + input.reservationSeconds > input.limitSeconds) {
                return { kind: 'duration-limit' };
            }
            return {
                kind: 'granted',
                reservation: { id: `reservation-${input.requestId}` },
            };
        });
        bindVoiceCapacityReservationMock.mockResolvedValue(true);
        releaseVoiceCapacityReservationMock.mockResolvedValue(true);
        fetchMock = vi.fn(upstreamFetch);
        vi.stubGlobal('fetch', fetchMock);
        logMock.mockReset();
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
        vi.unstubAllGlobals();
        delete process.env.ELEVENLABS_API_KEY;
        delete process.env.ELEVENLABS_AGENT_ID;
        delete process.env.ELEVENLABS_MAX_CONVERSATION_SECONDS;
        delete process.env.REVENUECAT_API_KEY;
        delete process.env.REVENUECAT_PROJECT_ID;
    });

    it.each([
        { endpoint: '/v1/voice/conversations', tokenField: 'conversationToken' },
        { endpoint: '/v1/voice/token', tokenField: 'token' },
    ])('uses only the server-owned agent for $endpoint', async ({ endpoint, tokenField }) => {
        const response = await app.inject({
            method: 'POST',
            url: endpoint,
            payload: { agentId: CLIENT_AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: true,
            agentId: SERVER_AGENT_ID,
            [tokenField]: CONVERSATION_TOKEN,
        });

        const upstreamUrls = fetchMock.mock.calls.map(([input]) => String(input));
        const tokenUrl = upstreamUrls.find((url) => url.includes('/conversation/token?'));
        expect(tokenUrl).toBeDefined();
        expect(new URL(tokenUrl!).searchParams.get('agent_id')).toBe(SERVER_AGENT_ID);
        expect(new URL(tokenUrl!).searchParams.get('participant_name')).toBe(response.json().elevenUserId);
        expect(upstreamUrls.every((url) => !url.includes(CLIENT_AGENT_ID))).toBe(true);
    });

    it('accepts the new client request shape with no bundled agent identifier', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: true,
            agentId: SERVER_AGENT_ID,
        });
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('commits and binds a provider-free capacity lease before minting for %s', async (endpoint) => {
        const requestId = '11111111-1111-4111-8111-111111111111';
        const response = await app.inject({
            method: 'POST',
            url: endpoint,
            payload: { requestId },
        });

        expect(response.statusCode).toBe(200);
        expect(reserveVoiceCapacityMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: USER_ID,
            requestId,
            reservationSeconds: 60,
        }));
        expect(bindVoiceCapacityReservationMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: USER_ID,
            reservationId: `reservation-${requestId}`,
            providerConversationId: CONVERSATION_ID,
        }));
        expect(JSON.stringify(bindVoiceCapacityReservationMock.mock.calls)).not.toContain(CONVERSATION_TOKEN);
        expect(reserveVoiceCapacityMock.mock.invocationCallOrder[0]).toBeLessThan(
            fetchMock.mock.invocationCallOrder.find((order, index) => (
                String(fetchMock.mock.calls[index]?.[0]).includes('/conversation/token?')
            ))!,
        );
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('allows only one provider mint when concurrent requests contend for the final slot on %s', async (endpoint) => {
        let granted = false;
        reserveVoiceCapacityMock.mockImplementation(async ({ requestId }: { requestId: string }) => {
            if (granted) return { kind: 'conversation-limit' };
            granted = true;
            return { kind: 'granted', reservation: { id: `reservation-${requestId}` } };
        });

        const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => app.inject({
            method: 'POST',
            url: endpoint,
            payload: { requestId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` },
        })));

        expect(responses.filter((response) => response.json().allowed === true)).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([input]) => (
            String(input).includes('/conversation/token?')
        ))).toHaveLength(1);
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('releases the unbound lease only after a definite provider rejection for %s', async (endpoint) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            if (String(input).includes('/conversations?')) {
                return jsonResponse({ conversations: [], has_more: false });
            }
            return jsonResponse({ error: 'rejected' }, 403);
        });

        const response = await app.inject({ method: 'POST', url: endpoint, payload: {} });

        expect(response.statusCode).toBe(500);
        expect(releaseVoiceCapacityReservationMock).toHaveBeenCalledOnce();
        expect(bindVoiceCapacityReservationMock).not.toHaveBeenCalled();
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('retains its lease when a minted provider response is ambiguous for %s', async (endpoint) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            if (String(input).includes('/conversations?')) {
                return jsonResponse({ conversations: [], has_more: false });
            }
            return jsonResponse({ token: 'not-a-valid-provider-jwt' });
        });

        const response = await app.inject({ method: 'POST', url: endpoint, payload: {} });

        expect(response.statusCode).toBe(500);
        expect(releaseVoiceCapacityReservationMock).not.toHaveBeenCalled();
        expect(bindVoiceCapacityReservationMock).not.toHaveBeenCalled();
    });

    it('fails closed before provider access when the enforced maximum duration is absent', async () => {
        delete process.env.ELEVENLABS_MAX_CONVERSATION_SECONDS;

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: {},
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(reserveVoiceCapacityMock).not.toHaveBeenCalled();
    });

    it('fails closed before contacting ElevenLabs when the server agent is not configured', async () => {
        delete process.env.ELEVENLABS_AGENT_ID;

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: { agentId: CLIENT_AGENT_ID },
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('fails closed without minting a token when usage lookup fails for %s', async (endpoint) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({ error: 'upstream unavailable' }, 503);
            }
            return upstreamFetch(input);
        });

        const response = await app.inject({
            method: 'POST',
            url: endpoint,
            payload: {},
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_check_failed' });
        const upstreamUrls = fetchMock.mock.calls.map(([input]) => String(input));
        expect(upstreamUrls).toHaveLength(1);
        expect(upstreamUrls[0]).toContain('/conversations?');
        expect(upstreamUrls[0]).not.toContain('/conversation/token?');
    });

    it.each([
        {
            boundary: 'conversation-count ceiling',
            conversations: Array.from({ length: 100 }, (_, index) => conversationSummary(0, index)),
        },
        {
            boundary: 'absolute usage hard cap',
            conversations: [conversationSummary(18_000)],
        },
    ])('enforces the $boundary before minting a legacy token', async ({ conversations }) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({ conversations, has_more: false });
            }
            return upstreamFetch(input);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/token',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            allowed: false,
            reason: 'voice_limit_reached',
            limitSeconds: 18_000,
            agentId: SERVER_AGENT_ID,
        });
        const upstreamUrls = fetchMock.mock.calls.map(([input]) => String(input));
        expect(upstreamUrls).toHaveLength(1);
        expect(upstreamUrls[0]).toContain('/conversations?');
        expect(upstreamUrls[0]).not.toContain('/conversation/token?');
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('rejects an oversized conversation-history response before token minting for %s', async (endpoint) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({
                    conversations: [],
                    has_more: false,
                    padding: 'x'.repeat(600_000),
                });
            }
            return upstreamFetch(input);
        });

        const response = await app.inject({ method: 'POST', url: endpoint, payload: {} });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_check_failed' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('rejects an oversized token envelope for %s', async (endpoint) => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({ conversations: [], has_more: false });
            }
            if (url.includes('/conversation/token?')) {
                return jsonResponse({ token: CONVERSATION_TOKEN, padding: 'x'.repeat(100_000) });
            }
            throw new Error(`Unexpected upstream request: ${url}`);
        });

        const response = await app.inject({ method: 'POST', url: endpoint, payload: {} });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_token_failed' });
    });

    it('rejects invalid negative usage instead of treating it as free capacity', async () => {
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({ conversations: [conversationSummary(-1)], has_more: false });
            }
            return upstreamFetch(input);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: {},
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_check_failed' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('treats an oversized RevenueCat response as no entitlement', async () => {
        process.env.REVENUECAT_API_KEY = 'revenuecat-key';
        process.env.REVENUECAT_PROJECT_ID = 'revenuecat-project';
        fetchMock.mockImplementation(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/conversations?')) {
                return jsonResponse({ conversations: [conversationSummary(3_600)], has_more: false });
            }
            if (url.includes('api.revenuecat.com')) {
                return jsonResponse({
                    object: 'list',
                    items: [{
                        object: 'customer.active_entitlement',
                        entitlement_id: 'premium',
                        expires_at: 1_900_000_000_000,
                    }],
                    next_page: null,
                    url: '/v2/projects/project/customers/user/active_entitlements',
                    padding: 'x'.repeat(150_000),
                });
            }
            return upstreamFetch(input);
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ allowed: false, reason: 'subscription_required' });
        expect(fetchMock.mock.calls.map(([input]) => String(input)).some(
            (url) => url.includes('/conversation/token?'),
        )).toBe(false);

    });

    it('rejects an invalid server agent identifier before contacting ElevenLabs', async () => {
        process.env.ELEVENLABS_AGENT_ID = 'https://attacker.example/agent';

        const response = await app.inject({
            method: 'POST',
            url: '/v1/voice/conversations',
            payload: {},
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toMatchObject({ reason: 'voice_not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        '/v1/voice/conversations',
        '/v1/voice/token',
    ])('does not pass user or conversation identifiers to logs for %s', async (endpoint) => {
        const response = await app.inject({
            method: 'POST',
            url: endpoint,
            payload: { agentId: CLIENT_AGENT_ID },
        });

        expect(response.statusCode).toBe(200);
        const logged = JSON.stringify(logMock.mock.calls);
        expect(logged).not.toContain(USER_ID);
        expect(logged).not.toContain(CONVERSATION_ID);
    });
});
