import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import qrcode from 'qrcode-terminal';
import { createInterface } from 'node:readline/promises';
import { encodeBase64, encodeBase64Url, decodeBase64, decryptBoxBundle, getRandomBytes } from './encryption';
import { writeCredentials, clearCredentials, readCredentials } from './credentials';
import type { Config } from './config';
import {
    buildAccountPairingMessage,
    decodeAccountPairingPayload,
    formatAccountPairingCode,
    normalizeServerUrl,
} from '@northglass/idle-wire';
import { AUTH_HTTP_CONFIG } from './httpSecurity';

const POLL_INTERVAL_MS = 1000;
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes

export type AuthRequestResponse = {
    state: 'requested' | 'authorized';
    response?: string; // base64-encoded encrypted credentials envelope
};

const MAX_AUTH_RESPONSE_CHARACTERS = 64 * 1024;

export type PairingCodeVerifier = (verificationCode: string) => Promise<boolean>;

function parseAuthRequestResponse(value: unknown): AuthRequestResponse {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Relay returned an invalid authentication response');
    }
    const candidate = value as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    if (candidate.state === 'requested' && keys.length === 1 && keys[0] === 'state') {
        return { state: 'requested' };
    }
    if (
        candidate.state === 'authorized'
        && keys.length === 2
        && keys[0] === 'response'
        && keys[1] === 'state'
        && typeof candidate.response === 'string'
        && candidate.response.length >= 4
        && candidate.response.length <= MAX_AUTH_RESPONSE_CHARACTERS
        && candidate.response.length % 4 === 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.response)
        && Buffer.from(candidate.response, 'base64').toString('base64') === candidate.response
    ) {
        return { state: 'authorized', response: candidate.response };
    }
    throw new Error('Relay returned an invalid authentication response');
}

export async function authLogin(
    config: Config,
    verifyPairingCode: PairingCodeVerifier = promptForPairingCode,
): Promise<void> {
    // 1. Generate ephemeral box keypair
    const seed = getRandomBytes(32);
    const keypair = tweetnacl.box.keyPair.fromSecretKey(seed);

    // 2. POST /v1/auth/account/request with publicKey
    const publicKeyBase64 = encodeBase64(keypair.publicKey);
    try {
        const initial = await axios.post(`${config.serverUrl}/v1/auth/account/request`, {
            version: 3,
            publicKey: publicKeyBase64,
        }, {
            headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
            ...AUTH_HTTP_CONFIG,
        });
        parseAuthRequestResponse(initial.data);
    } catch (err) {
        if (err instanceof AxiosError) {
            throw new Error(`Failed to initiate auth: ${err.message}`);
        }
        throw err;
    }

    // 3. Generate and display QR code
    const qrData = `idle:///account?${encodeBase64Url(keypair.publicKey)}`;
    console.log('');
    qrcode.generate(qrData, { small: true }, (code: string) => {
        console.log(code);
    });
    console.log('## Authentication');
    console.log('- Action: Scan this QR code with the Idle app');
    console.log('- Path: Settings -> Account -> Link New Device');
    console.log(`- Public Key: \`${publicKeyBase64}\``);
    console.log(`- URL: \`${qrData}\``);
    console.log('');

    // 4. Poll until authorized or timeout
    const startTime = Date.now();
    while (Date.now() - startTime < AUTH_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);

        let result: AuthRequestResponse;
        try {
            const resp = await axios.post(`${config.serverUrl}/v1/auth/account/request`, {
                version: 3,
                publicKey: publicKeyBase64,
            }, {
                headers: { 'X-Happy-Client': 'cli-control-plane/0.1.0' },
                ...AUTH_HTTP_CONFIG,
            });
            result = parseAuthRequestResponse(resp.data);
        } catch (err) {
            if (err instanceof AxiosError) {
                throw new Error(`Auth polling failed: ${err.message}`);
            }
            throw err;
        }

        if (result.state === 'authorized' && result.response) {
            // 5. Authenticate the approving account, relay audience, requester,
            // bearer, and account secret as one signed encrypted transcript.
            const credentials = decryptAndVerifyAccountPairing(
                result.response,
                keypair.secretKey,
                keypair.publicKey,
                config.serverUrl,
            );

            // 6. Require an out-of-band comparison with the approving app. A
            // malicious relay can construct its own signed transcript, but it
            // cannot make the intended app display the matching code.
            if (!await verifyPairingCode(credentials.verificationCode)) {
                throw new Error('Account pairing verification code was not confirmed');
            }

            // 7. Save credentials only after both cryptographic and human
            // identity confirmation succeed.
            writeCredentials(config, credentials.token, credentials.secret);

            console.log('## Authentication');
            console.log('- Status: Authenticated');
            return;
        }
    }

    throw new Error('Authentication timed out. Please try again.');
}

function decryptAndVerifyAccountPairing(
    encryptedResponseBase64: string,
    requesterSecretKey: Uint8Array,
    requesterPublicKey: Uint8Array,
    relayAudience: string,
): { token: string; secret: Uint8Array; verificationCode: string } {
    try {
        const cleartext = decryptBoxBundle(
            decodeBase64(encryptedResponseBase64),
            requesterSecretKey,
        );
        const payload = cleartext ? decodeAccountPairingPayload(cleartext) : null;
        if (!payload) throw new Error('invalid account pairing payload');
        if (payload.relayAudience !== normalizeServerUrl(relayAudience)) {
            throw new Error('account pairing relay audience mismatch');
        }
        if (payload.requesterPublicKey !== encodeBase64(requesterPublicKey)) {
            throw new Error('account pairing requester mismatch');
        }

        const secret = decodeBase64(payload.secret);
        const accountPublicKey = decodeBase64(payload.accountPublicKey);
        const signature = decodeBase64(payload.signature);
        const derivedAccountPublicKey = tweetnacl.sign.keyPair.fromSeed(secret).publicKey;
        if (encodeBase64(derivedAccountPublicKey) !== payload.accountPublicKey) {
            throw new Error('account pairing identity mismatch');
        }

        const { signature: _signature, ...unsigned } = payload;
        if (!tweetnacl.sign.detached.verify(
            buildAccountPairingMessage(unsigned),
            signature,
            accountPublicKey,
        )) {
            throw new Error('account pairing signature mismatch');
        }

        return {
            token: payload.token,
            secret,
            verificationCode: formatAccountPairingCode(signature),
        };
    } catch {
        throw new Error('Failed to authenticate account pairing response');
    }
}

async function promptForPairingCode(verificationCode: string): Promise<boolean> {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const entered = await readline.question(
            'Enter the verification code shown in the approving Idle app: ',
        );
        return entered.trim().toUpperCase() === verificationCode;
    } catch {
        return false;
    } finally {
        readline.close();
    }
}

export async function authLogout(config: Config): Promise<void> {
    clearCredentials(config);
    console.log('## Authentication');
    console.log('- Status: Logged out');
    console.log('- Credentials: Cleared');
}

export async function authStatus(config: Config): Promise<void> {
    const creds = readCredentials(config);
    console.log('## Authentication');
    if (creds) {
        console.log('- Status: Authenticated');
        console.log(`- Public Key: \`${encodeBase64(creds.contentKeyPair.publicKey)}\``);
    } else {
        console.log('- Status: Not authenticated');
        console.log('- Action: Run `idle-agent auth login` to authenticate.');
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
