/**
 * Auth endpoint security tests.
 *
 * Verify the server properly rejects invalid auth payloads and tokens.
 * These tests hit an explicitly selected deployed server and only exercise
 * error paths, so no valid account is needed.
 *
 * A network intermediary may block the explicitly selected target. When that
 * happens, the suite fails closed instead of treating the intermediary's
 * response as an Idle server response.
 */

import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import { buildAuthChallengeMessage } from '@northglass/idle-wire';
import { getExplicitLiveTestTarget } from '../../../testing/liveTestTarget';

const LIVE_TARGET = getExplicitLiveTestTarget();
const SERVER_URL = LIVE_TARGET ?? 'http://127.0.0.1:1';
const describeLive = LIVE_TARGET ? describe : describe.skip;

/**
 * Probe POST /v1/auth with an empty JSON body. Idle returns a structured 4xx
 * response, while a blocking intermediary commonly returns HTML or resets the
 * connection.
 */
async function isServerReachable(): Promise<boolean> {
    try {
        await axios.post(
            `${SERVER_URL}/v1/auth`,
            {},
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
        );
        // 2xx means server is up (unexpected for empty body, but still reachable)
        return true;
    } catch (err) {
        const e = err as AxiosError;
        if (!e.response) {
            // No response at all — connection reset / timeout / DNS failure
            return false;
        }
        const contentType = e.response.headers?.['content-type'];
        if (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')) {
            return false;
        }
        // Any HTTP response from the real server (4xx, 5xx) means it's reachable
        return true;
    }
}

describeLive('Auth endpoint security', () => {
    let reachable: boolean;

    beforeAll(async () => {
        reachable = await isServerReachable();
        if (!reachable) {
            throw new Error('Explicit live-test target is not directly reachable');
        }
    });

    it('rejects truncated auth token', { timeout: 30000 }, async () => {
        if (!reachable) return;

        const fakeToken = 'abcdef1234';
        try {
            const res = await axios.get(`${SERVER_URL}/v1/sessions`, {
                headers: { Authorization: `Bearer ${fakeToken}` },
            });
            expect.unreachable('Expected 401/403 but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            expect([401, 403]).toContain(e.response?.status);
        }
    });

    it('rejects empty bearer token', { timeout: 30000 }, async () => {
        if (!reachable) return;

        try {
            const res = await axios.get(`${SERVER_URL}/v1/sessions`, {
                headers: { Authorization: 'Bearer ' },
            });
            expect.unreachable('Expected 401/403 but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            expect([401, 403]).toContain(e.response?.status);
        }
    });

    it('rejects request with no auth header', { timeout: 30000 }, async () => {
        if (!reachable) return;

        try {
            const res = await axios.get(`${SERVER_URL}/v1/sessions`);
            expect.unreachable('Expected 401/403 but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            expect([401, 403]).toContain(e.response?.status);
        }
    });

    it('rejects malformed JSON in auth body', { timeout: 30000 }, async () => {
        if (!reachable) return;

        try {
            const res = await axios.post(
                `${SERVER_URL}/v1/auth`,
                'this is not json',
                { headers: { 'Content-Type': 'text/plain' } },
            );
            expect.unreachable('Expected 4xx but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            const status = e.response?.status;
            // Fastify may return 400, 403, or 415 depending on plugin order
            expect(status).toBeDefined();
            expect([400, 403, 415]).toContain(status);
        }
    });

    it('rejects auth with mismatched keypair', { timeout: 30000 }, async () => {
        if (!reachable) return;

        // Request a server challenge for key B, then sign it with key A.
        const keyPairA = tweetnacl.sign.keyPair();
        const keyPairB = tweetnacl.sign.keyPair();
        const publicKeyB64 = Buffer.from(keyPairB.publicKey).toString('base64');
        const challengeResponse = await axios.post(`${SERVER_URL}/v1/auth/challenge`, {
            version: 3,
            publicKey: publicKeyB64,
        });
        const challenge = challengeResponse.data as { challengeId: string; challenge: string };
        const signature = tweetnacl.sign.detached(
            buildAuthChallengeMessage(new URL(SERVER_URL).origin, challenge.challengeId, challenge.challenge),
            keyPairA.secretKey,
        );
        const signatureB64 = Buffer.from(signature).toString('base64');

        try {
            const res = await axios.post(`${SERVER_URL}/v1/auth`, {
                version: 3,
                publicKey: publicKeyB64,
                challengeId: challenge.challengeId,
                signature: signatureB64,
            });
            expect.unreachable('Expected 401/403 but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            expect([401, 403]).toContain(e.response?.status);
        }
    });

    it('handles oversized public key gracefully', { timeout: 30000 }, async () => {
        if (!reachable) return;

        // 100KB string as publicKey — server should return a client error, not crash
        const hugeKey = 'A'.repeat(100 * 1024);

        try {
            const res = await axios.post(`${SERVER_URL}/v1/auth`, {
                version: 3,
                publicKey: hugeKey,
                challengeId: '123e4567-e89b-12d3-a456-426614174000',
                signature: 'AAAA',
            });
            expect.unreachable('Expected 4xx but got ' + res.status);
        } catch (err) {
            const e = err as AxiosError;
            const status = e.response?.status;
            expect(status).toBeDefined();
            // Must be a client error (4xx), not a server error (5xx)
            expect(status).toBeGreaterThanOrEqual(400);
            expect(status).toBeLessThan(500);
        }
    });
});
