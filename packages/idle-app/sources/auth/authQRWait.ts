import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { QRAuthKeyPair } from './authQRStart';
import { getIdleClientId } from '@/sync/apiSocket';
import { decryptAccountPairingCredentials } from './authPairing';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
    verificationCode: string;
}

const ACCOUNT_PAIRING_POLL_INTERVAL_MS = 3_000;
const ACCOUNT_PAIRING_WAIT_TIMEOUT_MS = 5 * 60 * 1_000;

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;
    const serverUrl = getServerUrl();
    const expiresAt = Date.now() + ACCOUNT_PAIRING_WAIT_TIMEOUT_MS;

    while (Date.now() < expiresAt) {
        if (shouldCancel?.()) {
            return null;
        }

        try {
            const response = await axios.post(`${serverUrl}/v1/auth/account/request`, {
                version: 3,
                publicKey: encodeBase64(keypair.publicKey),
            }, {
                headers: {
                    'X-Happy-Client': getIdleClientId(),
                }
            });

            if (response.data.state === 'authorized') {
                const credentials = decryptAccountPairingCredentials(
                    response.data.response,
                    keypair.secretKey,
                    serverUrl,
                    keypair.publicKey,
                );
                if (credentials) {
                    return {
                        secret: credentials.secret,
                        token: credentials.token,
                        verificationCode: credentials.verificationCode,
                    };
                } else {
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return null;
                }
            }
        } catch (error) {
            console.log('\n\nFailed to check authentication status. Please try again.');
            return null;
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // The initial request was already created by authQRStart. Three-second
        // status polling keeps normal pairing responsive while bounding load
        // from a restore tab left open in the background.
        await new Promise(resolve => setTimeout(resolve, ACCOUNT_PAIRING_POLL_INTERVAL_MS));
    }

    return null;
}
