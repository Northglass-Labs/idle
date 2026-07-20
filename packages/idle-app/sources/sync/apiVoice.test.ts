import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://relay.example.test',
}));

vi.mock('./apiSocket', () => ({
    getIdleClientId: () => 'test-client',
}));

vi.mock('@/config', () => ({ config: {} }));

vi.mock('expo-crypto', () => ({
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
}));

import { fetchVoiceCredentials, VoiceTokenFetchError } from './apiVoice';

describe('fetchVoiceCredentials', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            allowed: true,
            conversationToken: 'server-minted-token',
            conversationId: 'conv_serverowned123',
            agentId: 'agent_serverowned123',
            elevenUserId: 'u_pseudonymous123',
            usedSeconds: 0,
            limitSeconds: 3600,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('asks the relay for its configured agent with a fresh idempotency coordinate', async () => {
        await expect(fetchVoiceCredentials({
            token: 'test-token',
            secret: 'test-secret',
        }, 'session-1')).resolves.toMatchObject({
            allowed: true,
            agentId: 'agent_serverowned123',
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'https://relay.example.test/v1/voice/conversations',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    requestId: '11111111-1111-4111-8111-111111111111',
                }),
            }),
        );
    });

    it('maps a structured relay failure to a fixed local message', async () => {
        const sensitiveMarker = 'provider-account-private-marker';
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            error: sensitiveMarker,
            reason: 'voice_token_failed',
            byokHint: true,
        }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
        }));

        const failure = await fetchVoiceCredentials({
            token: 'test-token',
            secret: 'test-secret',
        }, 'session-1').catch((error) => error);

        expect(failure).toBeInstanceOf(VoiceTokenFetchError);
        expect(failure.message).toBe('The voice provider could not start a conversation. Try again or use a custom voice agent in Settings.');
        expect(failure.message).not.toContain(sensitiveMarker);
    });
});
