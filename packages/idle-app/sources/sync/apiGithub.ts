import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getIdleClientId } from './apiSocket';
import { z } from 'zod';
import { GitHubProfileSchema, ImageRefSchema, type GitHubProfile as ProfileGitHubProfile } from './profile';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';

const MAX_GITHUB_RESPONSE_BYTES = 256 * 1024;
const TimestampSchema = z.number().int().nonnegative().max(253_402_300_799_000);
const SuccessResponseSchema = z.object({ success: z.literal(true) }).strict();

export interface AccountProfile {
    id: string;
    timestamp: number;
    github: ProfileGitHubProfile | null;
}

const AccountProfileResponseSchema = z.object({
    id: z.string().min(1).max(64),
    timestamp: TimestampSchema,
    firstName: z.string().max(256).nullable(),
    lastName: z.string().max(256).nullable(),
    username: z.string().max(256).nullable(),
    avatar: ImageRefSchema.nullable(),
    github: GitHubProfileSchema.nullable(),
}).strict();

/**
 * Get account profile including GitHub connection status
 */
export async function getAccountProfile(credentials: AuthCredentials): Promise<AccountProfile> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/account/profile`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to get account profile: ${response.status}`);
        }

        const data = AccountProfileResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_GITHUB_RESPONSE_BYTES,
        ));
        return { id: data.id, timestamp: data.timestamp, github: data.github };
    });
}

/**
 * Disconnect GitHub account from the user's profile
 */
export async function disconnectGitHub(credentials: AuthCredentials): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/connect/github`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'X-Happy-Client': getIdleClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('GitHub account not connected');
            }
            throw new Error(`Failed to disconnect GitHub: ${response.status}`);
        }

        const parsed = SuccessResponseSchema.safeParse(await readBoundedJsonResponse(
            response,
            MAX_GITHUB_RESPONSE_BYTES,
        ));
        if (!parsed.success) {
            throw new Error('Failed to disconnect GitHub account');
        }
    });
}
