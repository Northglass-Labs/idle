import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import axios from 'axios';
import { encodeBase64 } from '../encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { getIdleClientId } from '@/sync/apiSocket';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getServerUrl();
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Sending authentication request');
        }

        await axios.post(`${serverUrl}/v1/auth/account/request`, {
            version: 3,
            publicKey: encodeBase64(keypair.publicKey),
        }, {
            headers: {
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Authentication request failed');
        }
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}
