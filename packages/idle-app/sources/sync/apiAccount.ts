import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

/**
 * Permanently delete the user's account and all of its server-side data
 * (sessions, messages, machines, files, usage, tokens).
 *
 * Backs the in-app "Delete Account" flow required by App Store Guideline
 * 5.1.1(v). The server operation is idempotent. After this resolves the caller
 * must clear local credentials (auth.logout) — the account no longer exists on
 * the relay, so the token is now invalid.
 */
export async function deleteAccount(credentials: AuthCredentials): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/account/delete`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to delete account: ${response.status}`);
    }
}
