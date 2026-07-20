import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { TokenSchema } from "@/app/api/routes/_schemas";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import { buildSessionEventEphemeral, eventRouter } from "@/app/events/eventRouter";
import { inTx } from "@/storage/inTx";
import { MAX_PUSH_TOKENS_PER_ACCOUNT } from "@/app/push/pushTokenLimits";

type SessionNotificationKind = 'done' | 'permission' | 'question';

function getSessionNotificationCopy(kind: SessionNotificationKind): { title: string; body: string } {
    const title = kind === 'done'
        ? "It's ready!"
        : kind === 'permission'
            ? 'Permission request'
            : 'Clarification needed';

    return {
        title,
        body: 'Open Idle to review this session.',
    };
}

export function pushRoutes(app: Fastify) {

    // Push Token Registration API
    app.post('/v1/push-tokens', {
        schema: {
            body: z.object({
                token: TokenSchema
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                409: z.object({
                    error: z.literal('Push token limit reached')
                }),
                500: z.object({
                    error: z.literal('Failed to register push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.body;

        try {
            // `inTx` uses Serializable isolation and retries write conflicts, so
            // concurrent distinct enrollments cannot both commit past the cap.
            const registered = await inTx(async (tx) => {
                // Check the exact token first: refreshing an existing device must
                // remain idempotent even when the account is already at capacity.
                const existing = await tx.accountPushToken.findUnique({
                    where: {
                        accountId_token: {
                            accountId: userId,
                            token
                        }
                    },
                    select: { id: true }
                });

                if (!existing) {
                    const tokenCount = await tx.accountPushToken.count({
                        where: { accountId: userId }
                    });
                    if (tokenCount >= MAX_PUSH_TOKENS_PER_ACCOUNT) {
                        return false;
                    }
                }

                await tx.accountPushToken.upsert({
                    where: {
                        accountId_token: {
                            accountId: userId,
                            token
                        }
                    },
                    update: {
                        updatedAt: new Date()
                    },
                    create: {
                        accountId: userId,
                        token
                    }
                });
                return true;
            });

            if (!registered) {
                return reply.code(409).send({ error: 'Push token limit reached' });
            }
            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to register push token' });
        }
    });

    // Delete Push Token API
    app.delete('/v1/push-tokens/:token', {
        schema: {
            params: z.object({
                token: TokenSchema
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                500: z.object({
                    error: z.literal('Failed to delete push token')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { token } = request.params;

        try {
            await db.accountPushToken.deleteMany({
                where: {
                    accountId: userId,
                    token: token
                }
            });

            return reply.send({ success: true });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to delete push token' });
        }
    });

    // Session-Event Push API
    // CLI/daemon clients call this instead of talking to Expo directly so the
    // server can apply presence-based suppression (active desktop/web/mobile).
    app.post('/v1/sessions/:sessionId/push-event', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                kind: z.enum(['done', 'permission', 'question']),
                title: z.string().min(1).max(200),
                body: z.string().min(1).max(500),
                data: z.record(z.string(), z.unknown()).optional()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Session not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { kind } = request.body;
        const { title, body } = getSessionNotificationCopy(kind);

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Fan out the event to user's connected clients (web tabs use this to
        // bump tab-title unread counter for "user attention needed" moments only,
        // instead of pinging on every encrypted message).
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionEventEphemeral(sessionId, kind, title, body),
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        void dispatchSessionEventPush({
            userId,
            sessionId,
            title,
            body,
            data: { kind }
        });

        return reply.send({ success: true });
    });

    // Get Push Tokens API
    app.get('/v1/push-tokens', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const tokens = await db.accountPushToken.findMany({
                where: {
                    accountId: userId
                },
                orderBy: {
                    updatedAt: 'desc'
                },
                take: MAX_PUSH_TOKENS_PER_ACCOUNT
            });
            const boundedTokens = tokens.slice(0, MAX_PUSH_TOKENS_PER_ACCOUNT);

            return reply.send({
                tokens: boundedTokens.map(t => ({
                    id: t.id,
                    token: t.token,
                    createdAt: t.createdAt.getTime(),
                    updatedAt: t.updatedAt.getTime()
                }))
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get push tokens' });
        }
    });
}
