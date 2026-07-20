import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';
import { encodeBase64, getRandomBytes, libsodiumEncryptForPublicKey } from './encryption';
import { readCredentials, writeCredentials } from './credentials';
import type { Config } from './config';
import {
    buildAccountPairingMessage,
    encodeAccountPairingPayload,
} from '@northglass/idle-wire';

// Mock axios
vi.mock('axios', () => {
    const fn = vi.fn();
    return {
        default: { post: fn },
        AxiosError: class AxiosError extends Error {
            constructor(message: string) {
                super(message);
                this.name = 'AxiosError';
            }
        },
    };
});

// Mock qrcode-terminal
vi.mock('qrcode-terminal', () => ({
    default: {
        generate: vi.fn((_data: string, _opts: unknown, cb: (code: string) => void) => {
            cb('[QR CODE]');
        }),
    },
}));

// Mock chalk to pass-through
vi.mock('chalk', () => ({
    default: {
        bold: (s: string) => s,
        dim: (s: string) => s,
        green: (s: string) => s,
        yellow: (s: string) => s,
    },
}));

import axios from 'axios';
import { authLogin, authLogout, authStatus } from './auth';

const mockedAxiosPost = vi.mocked(axios.post);

function makeTestConfig(): Config {
    const homeDir = mkdtempSync(join(tmpdir(), 'idle-agent-auth-test-'));
    return {
        serverUrl: 'https://test-server.example.com',
        homeDir,
        credentialPath: join(homeDir, 'agent.key'),
    };
}

function makePairingResponse(
    secret: Uint8Array,
    publicKey: Uint8Array,
    token: string,
    relayAudience = 'https://test-server.example.com',
) {
    const accountKeyPair = tweetnacl.sign.keyPair.fromSeed(secret);
    const unsigned = {
        type: 'idle-account-pairing' as const,
        version: 3 as const,
        relayAudience,
        requesterPublicKey: encodeBase64(publicKey),
        accountPublicKey: encodeBase64(accountKeyPair.publicKey),
        token,
        secret: encodeBase64(secret),
    };
    const signature = tweetnacl.sign.detached(
        buildAccountPairingMessage(unsigned),
        accountKeyPair.secretKey,
    );
    const encryptedCredentials = libsodiumEncryptForPublicKey(encodeAccountPairingPayload({
        ...unsigned,
        signature: encodeBase64(signature),
    }), publicKey);
    return {
        state: 'authorized',
        response: encodeBase64(encryptedCredentials),
    };
}

describe('auth', () => {
    let config: Config;
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        config = makeTestConfig();
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockedAxiosPost.mockReset();
    });

    afterEach(() => {
        rmSync(config.homeDir, { recursive: true, force: true });
        consoleSpy.mockRestore();
    });

    describe('authLogin', () => {
        it('uses bounded, non-redirecting transport before accepting auth material', async () => {
            mockedAxiosPost.mockResolvedValueOnce({ data: { state: 'requested' } });
            mockedAxiosPost.mockRejectedValueOnce(new Error('stop polling'));

            await expect(authLogin(config)).rejects.toThrow('stop polling');

            for (const call of mockedAxiosPost.mock.calls) {
                const requestConfig = call[2] as Record<string, unknown>;
                expect(requestConfig).toMatchObject({ maxRedirects: 0 });
                expect(requestConfig.timeout).toEqual(expect.any(Number));
                expect(requestConfig.maxContentLength).toEqual(expect.any(Number));
                expect(requestConfig.maxBodyLength).toEqual(expect.any(Number));
                expect(requestConfig.timeout as number).toBeGreaterThan(0);
                expect(requestConfig.maxContentLength as number).toBeLessThanOrEqual(1024 * 1024);
                expect(requestConfig.maxBodyLength as number).toBeLessThanOrEqual(1024 * 1024);
            }
        });

        it('completes the auth flow on first poll response', async () => {
            // The auth flow makes two POST calls:
            // 1. Initial request to register the public key
            // 2. Poll that returns authorized state

            const accountSecret = getRandomBytes(32);

            // Capture the ephemeral public key so the authorized response is
            // encrypted to the same request.
            let capturedPublicKey: Uint8Array | null = null;

            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                const body = data as { publicKey: string };
                if (!capturedPublicKey) {
                    // First call - initial request
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'requested' } };
                }

                // Second call - poll returns authorized
                // Encrypt the account secret using the ephemeral public key
                return { data: makePairingResponse(accountSecret, capturedPublicKey, 'test-jwt-token') };
            });

            await authLogin(config, async () => true);

            // Verify credentials were saved
            const creds = readCredentials(config);
            expect(creds).not.toBeNull();
            expect(creds!.token).toBe('test-jwt-token');
            expect(creds!.secret).toEqual(accountSecret);

            // Verify axios was called with correct URL
            expect(mockedAxiosPost).toHaveBeenCalledWith(
                'https://test-server.example.com/v1/auth/account/request',
                expect.objectContaining({ version: 3, publicKey: expect.any(String) }),
                expect.objectContaining({
                    headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
                }),
            );
        });

        it('polls multiple times before success', async () => {
            const accountSecret = getRandomBytes(32);
            let capturedPublicKey: Uint8Array | null = null;
            let callCount = 0;

            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                callCount++;
                const body = data as { publicKey: string };

                if (callCount === 1) {
                    // Initial request
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'requested' } };
                }

                if (callCount <= 3) {
                    // Polls 2 and 3 return pending
                    return { data: { state: 'requested' } };
                }

                // Poll 4 returns authorized
                return { data: makePairingResponse(accountSecret, capturedPublicKey!, 'multi-poll-token') };
            });

            await authLogin(config, async () => true);

            const creds = readCredentials(config);
            expect(creds).not.toBeNull();
            expect(creds!.token).toBe('multi-poll-token');
            expect(creds!.secret).toEqual(accountSecret);
            expect(callCount).toBe(4); // 1 initial + 3 polls
        });

        it('throws when initial request fails', async () => {
            const { AxiosError } = await import('axios');
            mockedAxiosPost.mockRejectedValueOnce(new AxiosError('Network Error'));

            await expect(authLogin(config)).rejects.toThrow('Failed to initiate auth: Network Error');
        });

        it('throws when polling fails', async () => {
            const { AxiosError } = await import('axios');

            let callCount = 0;
            mockedAxiosPost.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { data: { state: 'requested' } };
                }
                throw new AxiosError('Connection refused');
            });

            await expect(authLogin(config)).rejects.toThrow('Auth polling failed: Connection refused');
        });

        it('rejects an invalid relay auth response schema', async () => {
            mockedAxiosPost
                .mockResolvedValueOnce({ data: { state: 'requested' } })
                .mockResolvedValueOnce({ data: { state: 'authorized', response: 42 } });

            await expect(authLogin(config))
                .rejects.toThrow('Relay returned an invalid authentication response');
            expect(readCredentials(config)).toBeNull();
        });

        it('throws when decryption fails (wrong key)', async () => {
            // Encrypt with a different public key so decryption fails
            const wrongKeyPair = tweetnacl.box.keyPair();
            const accountSecret = getRandomBytes(32);
            const encryptedWithWrongKey = makePairingResponse(accountSecret, wrongKeyPair.publicKey, 'bad-token');

            let callCount = 0;
            mockedAxiosPost.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { data: { state: 'requested' } };
                }
                return {
                    data: {
                        state: 'authorized',
                        response: encryptedWithWrongKey.response,
                    },
                };
            });

            await expect(authLogin(config)).rejects.toThrow('Failed to authenticate account pairing response');
        });

        it('rejects a signed account response from another relay audience', async () => {
            const accountSecret = getRandomBytes(32);
            let capturedPublicKey: Uint8Array | null = null;
            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                const body = data as { publicKey: string };
                if (!capturedPublicKey) {
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'requested' } };
                }
                return {
                    data: makePairingResponse(
                        accountSecret,
                        capturedPublicKey,
                        'token',
                        'https://other-relay.example.com',
                    ),
                };
            });

            await expect(authLogin(config, async () => true)).rejects.toThrow(/pairing response/i);
            expect(readCredentials(config)).toBeNull();
        });

        it('does not persist credentials until the user confirms the app verification code', async () => {
            const accountSecret = getRandomBytes(32);
            let capturedPublicKey: Uint8Array | null = null;
            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                const body = data as { publicKey: string };
                if (!capturedPublicKey) {
                    capturedPublicKey = new Uint8Array(Buffer.from(body.publicKey, 'base64'));
                    return { data: { state: 'requested' } };
                }
                return { data: makePairingResponse(accountSecret, capturedPublicKey, 'token') };
            });

            const verifier = vi.fn(async () => false);
            await expect(authLogin(config, verifier)).rejects.toThrow(/verification code/i);
            expect(verifier).toHaveBeenCalledWith(expect.stringMatching(/^[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/));
            expect(readCredentials(config)).toBeNull();
        });

        it('sends publicKey as base64 in request body', async () => {
            const accountSecret = getRandomBytes(32);
            let callCount = 0;
            mockedAxiosPost.mockImplementation(async (_url: string, data?: unknown) => {
                callCount++;
                const body = data as { publicKey: string };

                // The request always carries a canonical 32-byte NaCl key.
                const decoded = Buffer.from(body.publicKey, 'base64');
                expect(decoded.length).toBe(32);

                if (callCount === 1) {
                    return { data: { state: 'requested' } };
                }

                const pubKey = new Uint8Array(decoded);
                return { data: makePairingResponse(accountSecret, pubKey, 'token') };
            });

            await authLogin(config, async () => true);
        });
    });

    describe('authLogout', () => {
        it('clears stored credentials', async () => {
            // First write some credentials
            writeCredentials(config, 'some-token', getRandomBytes(32));
            expect(existsSync(config.credentialPath)).toBe(true);

            await authLogout(config);

            expect(existsSync(config.credentialPath)).toBe(false);
        });

        it('does not throw when no credentials exist', async () => {
            await expect(authLogout(config)).resolves.toBeUndefined();
        });

        it('prints logout message', async () => {
            await authLogout(config);
            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Logged out');
            expect(calls).toContain('- Credentials: Cleared');
        });
    });

    describe('authStatus', () => {
        it('shows authenticated status when credentials exist', async () => {
            writeCredentials(config, 'test-token', getRandomBytes(32));

            await authStatus(config);

            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Authenticated');
        });

        it('shows not authenticated when no credentials', async () => {
            await authStatus(config);

            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            expect(calls).toContain('## Authentication');
            expect(calls).toContain('- Status: Not authenticated');
        });

        it('shows public key when authenticated', async () => {
            const secret = getRandomBytes(32);
            writeCredentials(config, 'test-token', secret);

            await authStatus(config);

            // Should include a call with the public key
            const calls = consoleSpy.mock.calls.map(c => String(c[0]));
            const pubKeyCall = calls.find(c => c.includes('- Public Key: `'));
            expect(pubKeyCall).toBeDefined();
        });
    });
});
