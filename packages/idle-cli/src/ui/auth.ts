import { encodeBase64, encodeBase64Url } from "@/api/encryption";
import { configuration } from "@/configuration";
import { randomBytes } from "node:crypto";
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { displayQRCode } from "./qrcode";
import { delay } from "@/utils/time";
import { writeCredentialsLegacy, readCredentials, updateSettings, Credentials, writeCredentialsDataKey } from "@/persistence";
import { generateWebAuthUrl } from "@/api/webAuth";
import { openBrowser } from "@/utils/browser";
import { AuthSelector, AuthMethod } from "./ink/AuthSelector";
import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import {
    decryptPairingCredentials,
    usesLegacyTokenOutsidePairingEnvelope,
} from '@/api/pairing';

export async function doAuth(): Promise<Credentials | null> {
    console.clear();

    // Show authentication method selector
    const authMethod = await selectAuthenticationMethod();
    if (!authMethod) {
        console.log('\nAuthentication cancelled.\n');
        process.exit(0);
    }

    // Generating ephemeral key
    const secret = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);

    // Create a new authentication request
    try {
        if (process.env.DEBUG) {
            console.log('[AUTH DEBUG] Sending authentication request');
        }
        await axios.post(`${configuration.serverUrl}/v1/auth/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            supportsV2: true
        }, {
            headers: {
                'X-Happy-Client': `cli/${configuration.currentCliVersion}`
            }
        });
        if (process.env.DEBUG) {
            console.log(`[AUTH DEBUG] Auth request sent successfully`);
        }
    } catch {
        if (process.env.DEBUG) {
            console.log('[AUTH DEBUG] Authentication request failed');
        }
        console.log('Failed to create authentication request, please try again later.');
        return null;
    }

    // Handle authentication based on selected method
    if (authMethod === 'mobile') {
        return await doMobileAuth(keypair);
    } else {
        return await doWebAuth(keypair);
    }
}

/**
 * Display authentication method selector and return user choice
 */
function selectAuthenticationMethod(): Promise<AuthMethod | null> {
    return new Promise((resolve) => {
        let hasResolved = false;

        const onSelect = (method: AuthMethod) => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(method);
            }
        };

        const onCancel = () => {
            if (!hasResolved) {
                hasResolved = true;
                app.unmount();
                resolve(null);
            }
        };

        const app = render(React.createElement(AuthSelector, { onSelect, onCancel }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    });
}

/**
 * Handle mobile authentication flow
 */
async function doMobileAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nMobile Authentication\n');
    console.log('Scan this QR code with your Idle mobile app:\n');

    const authUrl = 'idle://terminal?' + encodeBase64Url(keypair.publicKey);
    displayQRCode(authUrl);

    console.log('\nOr manually enter this URL:');
    console.log(authUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Handle web authentication flow
 */
async function doWebAuth(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    console.clear();
    console.log('\nWeb Authentication\n');

    const webUrl = generateWebAuthUrl(keypair.publicKey);
    console.log('Opening your browser...');

    const browserOpened = await openBrowser(webUrl);

    if (browserOpened) {
        console.log('✓ Browser opened\n');
        console.log('Complete authentication in your browser window.');
    } else {
        console.log('Could not open browser automatically.');
    }

    // Always print the fallback URL because remote and container environments
    // may not support launching a local browser.
    console.log('\nIf the browser did not open, please copy and paste this URL:');
    console.log(webUrl);
    console.log('');

    return await waitForAuthentication(keypair);
}

/**
 * Wait for authentication to complete and return credentials.
 *
 * Poll the bounded status endpoint at a rate below its request budget, and
 * fetch the encrypted credential exactly once after authorization. Transient
 * failures use capped exponential backoff; a bounded consecutive-failure limit
 * terminates an unavailable authentication flow with an actionable error. If
 * the relay expires a pending request, renew that same displayed public key so
 * the QR remains valid without changing the key the mobile device scanned.
 */
export async function waitForAuthentication(keypair: tweetnacl.BoxKeyPair): Promise<Credentials | null> {
    process.stdout.write('Waiting for authentication');
    let dots = 0;
    let cancelled = false;

    const INITIAL_POLL_MS = 2000;
    const MAX_POLL_MS = 10_000;
    const MAX_CONSECUTIVE_FAILURES = 30;
    let pollMs = INITIAL_POLL_MS;
    let consecutiveFailures = 0;

    const publicKeyB64 = encodeBase64(keypair.publicKey);

    const handleInterrupt = () => {
        cancelled = true;
        console.log('\n\nAuthentication cancelled.');
        process.exit(0);
    };
    process.on('SIGINT', handleInterrupt);

    try {
        while (!cancelled) {
            try {
                // Cheap status probe (30/min limit, no token returned).
                const statusResp = await axios.get(
                    `${configuration.serverUrl}/v1/auth/request/status`,
                    { params: { publicKey: publicKeyB64 } }
                );

                if (
                    statusResp.data.status === 'authorized'
                    || statusResp.data.status === 'not_found'
                ) {
                    // Fetch completed credentials, or recreate an expired
                    // request with the same key represented by the displayed QR.
                    const response = await axios.post(
                        `${configuration.serverUrl}/v1/auth/request`,
                        { publicKey: publicKeyB64, supportsV2: true },
                        {
                            headers: {
                                'X-Happy-Client': `cli/${configuration.currentCliVersion}`
                            }
                        }
                    );
                    if (response.data.state === 'requested') {
                        // The relay renewed the request. Preserve the same QR,
                        // wait at the normal interval, and resume status probes.
                        consecutiveFailures = 0;
                        pollMs = INITIAL_POLL_MS;
                        process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
                        dots++;
                        await delay(pollMs);
                        continue;
                    }
                    if (response.data.state !== 'authorized') {
                        // The bounded relay state machine returned an invalid
                        // transition that cannot be recovered in this attempt.
                        console.log('\n\nAuthentication completed on phone but the token fetch did not match. Please try again.');
                        return null;
                    }
                    if (usesLegacyTokenOutsidePairingEnvelope(response.data)) {
                        console.log(
                            '\n\nThe relay uses an obsolete pairing protocol that this Idle version rejects. Upgrade the relay and try again.',
                        );
                        return null;
                    }
                    const pairing = decryptPairingCredentials(response.data.response, keypair.secretKey);
                    if (!pairing) {
                        console.log('\n\nFailed to decrypt response. Please try again.');
                        return null;
                    }
                    const { token, rpcRegistrationToken, response: decrypted } = pairing;
                    if (decrypted.length === 32) {
                        const credentials = { secret: decrypted, token, rpcRegistrationToken };
                        await writeCredentialsLegacy(credentials);
                        console.log('\n\n✓ Authentication successful\n');
                        return {
                            encryption: { type: 'legacy', secret: decrypted },
                            token,
                            ...(rpcRegistrationToken ? { rpcRegistrationToken } : {}),
                        };
                    }
                    if (decrypted[0] === 0) {
                        const credentials = {
                            publicKey: decrypted.slice(1, 33),
                            machineKey: randomBytes(32),
                            token,
                            rpcRegistrationToken,
                        };
                        await writeCredentialsDataKey(credentials);
                        console.log('\n\n✓ Authentication successful\n');
                        return {
                            encryption: {
                                type: 'dataKey',
                                publicKey: credentials.publicKey,
                                machineKey: credentials.machineKey,
                            },
                            token,
                            ...(rpcRegistrationToken ? { rpcRegistrationToken } : {}),
                        };
                    }
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                }
                // A pending request is healthy and can return to the initial
                // polling interval.
                consecutiveFailures = 0;
                pollMs = INITIAL_POLL_MS;
            } catch (error: unknown) {
                consecutiveFailures++;
                const httpStatus = (error as { response?: { status?: number } })?.response?.status;
                // Back off every transient failure, including rate limits and a
                // failed renewal, so an unavailable relay cannot trigger a burst.
                pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    const msg = httpStatus === 429
                        ? `\n\nServer rate-limited the client for ${consecutiveFailures} attempts in a row. Please try again later.`
                        : `\n\nFailed to check authentication status after ${consecutiveFailures} attempts. Please try again.`;
                    console.log(msg);
                    return null;
                }
                // Otherwise tolerate and keep polling (transient errors are normal).
            }

            process.stdout.write('\rWaiting for authentication' + '.'.repeat((dots % 3) + 1) + '   ');
            dots++;
            await delay(pollMs);
        }
    } finally {
        process.off('SIGINT', handleInterrupt);
    }

    return null;
}

/**
 * Ensure authentication and machine setup
 * This replaces the onboarding flow and ensures everything is ready
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    // Step 1: Handle authentication
    let credentials = await readCredentials();
    let newAuth = false;

    if (!credentials) {
        logger.debug('[AUTH] No credentials found, starting authentication flow...');
        const authResult = await doAuth();
        if (!authResult) {
            throw new Error('Authentication failed or was cancelled');
        }
        credentials = authResult;
        newAuth = true;
    } else {
        logger.debug('[AUTH] Using existing credentials');
    }

    // Make sure we have a machine ID
    // Server machine entity will be created either by the daemon or by the CLI
    const settings = await updateSettings(async s => {
        if (newAuth || !s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug('[AUTH] Machine identity is configured');

    return { credentials, machineId: settings.machineId! };
}
