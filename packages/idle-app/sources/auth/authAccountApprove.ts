import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl } from "@/sync/serverConfig";
import { getIdleClientId } from "@/sync/apiSocket";
import { createAccountPairingApproval } from './authPairing';

export async function authAccountApprove(
    token: string,
    publicKey: Uint8Array,
    accountSecret: Uint8Array,
): Promise<string> {
    const API_ENDPOINT = getServerUrl();
    const approval = createAccountPairingApproval({
        relayAudience: API_ENDPOINT,
        requesterPublicKey: publicKey,
        accountSecret,
        token,
    });
    await axios.post(`${API_ENDPOINT}/v1/auth/account/response`, {
        version: 3,
        publicKey: encodeBase64(publicKey),
        response: encodeBase64(approval.response),
    }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-Happy-Client': getIdleClientId(),
        }
    });
    return approval.verificationCode;
}
