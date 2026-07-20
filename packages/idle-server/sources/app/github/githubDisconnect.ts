import { db } from "@/storage/db";
import { Context } from "@/context";
import { log } from "@/utils/log";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { decryptString } from "@/modules/encrypt";

async function revokeGithubAuthorization(accessToken: string): Promise<void> {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GitHub OAuth credentials are not configured');
    }

    const response = await fetch(
        `https://api.github.com/applications/${encodeURIComponent(clientId)}/grant`,
        {
            method: 'DELETE',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({ access_token: accessToken }),
            signal: AbortSignal.timeout(10_000),
        },
    );

    // A missing token is already revoked and safe to remove locally.
    if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to revoke GitHub access token (status ${response.status})`);
    }
}

/**
 * Disconnects a GitHub account from a user profile.
 *
 * Flow:
 * 1. Check if user has GitHub connected - early exit if not
 * 2. In transaction: clear GitHub link and username from account (keeps avatar) and delete GitHub user record
 * 3. Send socket update after transaction completes
 *
 * @param ctx - Request context containing user ID
 */
export async function githubDisconnect(ctx: Context): Promise<void> {
    const userId = ctx.uid;

    // Step 1: Check if user has GitHub connection
    const user = await db.account.findUnique({
        where: { id: userId },
        select: { githubUserId: true }
    });

    // Early exit if no GitHub connection
    if (!user?.githubUserId) {
        log({ module: 'github-disconnect' }, 'No GitHub account is connected');
        return;
    }

    const githubUserId = user.githubUserId;
    const githubUser = await db.githubUser.findUnique({
        where: { id: githubUserId },
        select: { token: true },
    });
    if (githubUser?.token) {
        const accessToken = decryptString(['user', userId, 'github', 'token'], githubUser.token);
        await revokeGithubAuthorization(accessToken);
    }

    log({ module: 'github-disconnect' }, 'Disconnecting GitHub account');

    // Step 2: Transaction for atomic database operations
    await db.$transaction(async (tx) => {
        // Clear GitHub connection and username from account (keep avatar)
        const { count } = await tx.account.updateMany({
            where: {
                id: userId,
                githubUserId,
            },
            data: {
                githubUserId: null,
                username: null
            }
        });
        if (count === 0) {
            throw new Error('GitHub connection changed while disconnecting');
        }

        // Delete GitHub user record (includes token)
        await tx.githubUser.delete({
            where: { id: githubUserId }
        });
    });

    // Step 3: Send update via socket (after transaction completes)
    const updSeq = await allocateUserSeq(userId);
    const updatePayload = buildUpdateAccountUpdate(userId, {
        github: null,
        username: null
    }, updSeq, randomKeyNaked(12));

    eventRouter.emitUpdate({
        userId,
        payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' }
    });

    log({ module: 'github-disconnect' }, 'GitHub account disconnected successfully');
}
