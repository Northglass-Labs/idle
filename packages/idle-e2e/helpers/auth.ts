import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { buildAuthChallengeMessage } from '@northglass/idle-wire';
export { SERVER_URL } from './liveTarget';
import { SERVER_URL } from './liveTarget';

export interface TestAccount {
    publicKey: string;
    secretKey: Uint8Array;
    token: string;
}

/**
 * Create a test account by authenticating with the server's challenge-response flow.
 *
 * How it works:
 * 1. Generate an ed25519 signing keypair (tweetnacl.sign)
 * 2. Request a short-lived challenge from the server
 * 3. Sign the domain-separated challenge with the secret key
 * 4. POST { version: 3, publicKey, challengeId, signature } to /v1/auth
 * 5. Server atomically consumes the challenge and returns a token
 */
export async function createTestAccount(): Promise<TestAccount> {
    // Generate a random 32-byte seed, then derive an ed25519 signing keypair
    const seed = tweetnacl.randomBytes(32);
    const keypair = tweetnacl.sign.keyPair.fromSeed(seed);

    const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
    const challengeResponse = await axios.post(`${SERVER_URL}/v1/auth/challenge`, {
        version: 3,
        publicKey: publicKeyB64,
    });
    const { version, challengeId, challenge } = challengeResponse.data as {
        version: unknown;
        challengeId: string;
        challenge: string;
    };
    if (version !== 3) throw new Error('Unsupported auth challenge protocol version');
    const signature = tweetnacl.sign.detached(
        buildAuthChallengeMessage(new URL(SERVER_URL).origin, challengeId, challenge),
        keypair.secretKey,
    );
    const signatureB64 = Buffer.from(signature).toString('base64');

    const response = await axios.post(`${SERVER_URL}/v1/auth`, {
        version: 3,
        publicKey: publicKeyB64,
        challengeId,
        signature: signatureB64,
    });

    if (!response.data.success || !response.data.token) {
        throw new Error(`Auth failed: ${JSON.stringify(response.data)}`);
    }

    return {
        publicKey: publicKeyB64,
        secretKey: seed,
        token: response.data.token,
    };
}

/**
 * Clean up a test account's sessions and machines.
 *
 * Calls DELETE endpoints to remove server-side state created during tests.
 * Failures are logged but not thrown — cleanup is best-effort.
 */
export async function cleanupTestAccount(account: TestAccount): Promise<void> {
    const client = axios.create({
        baseURL: SERVER_URL,
        headers: { Authorization: `Bearer ${account.token}` },
    });

    try {
        await client.delete('/v1/sessions');
    } catch {
        // Best-effort cleanup — server may not support bulk delete
    }

    try {
        await client.delete('/v1/machines');
    } catch {
        // Best-effort cleanup
    }
}
