import sodium from '@/encryption/libsodium.lib';
import { buildAuthChallengeMessage } from '@northglass/idle-wire';

export function getAuthPublicKey(secret: Uint8Array): Uint8Array {
    return sodium.crypto_sign_seed_keypair(secret).publicKey;
}

export function signAuthChallenge(
    secret: Uint8Array,
    audience: string,
    challengeId: string,
    challenge: string,
) {
    const keypair = sodium.crypto_sign_seed_keypair(secret);
    const signature = sodium.crypto_sign_detached(
        buildAuthChallengeMessage(audience, challengeId, challenge),
        keypair.privateKey,
    );
    return { signature, publicKey: keypair.publicKey };
}
