import { getAuthPublicKey, signAuthChallenge } from "./authChallenge";
import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getIdleClientId } from "@/sync/apiSocket";

export async function authGetToken(secret: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const headers = { 'X-Happy-Client': getIdleClientId() };
    const publicKey = getAuthPublicKey(secret);
    const challengeResponse = await axios.post(`${API_ENDPOINT}/v1/auth/challenge`, {
        version: 3,
        publicKey: encodeBase64(publicKey),
    }, { headers });
    const { version, challengeId, challenge } = challengeResponse.data as {
        version: unknown;
        challengeId: string;
        challenge: string;
    };
    if (version !== 3) {
        throw new Error('Unsupported authentication protocol version');
    }
    const proof = signAuthChallenge(secret, API_ENDPOINT, challengeId, challenge);
    const response = await axios.post(`${API_ENDPOINT}/v1/auth`, {
        version: 3,
        challengeId,
        signature: encodeBase64(proof.signature),
        publicKey: encodeBase64(proof.publicKey),
    }, { headers });
    const data = response.data;
    return data.token;
}
