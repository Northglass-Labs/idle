import { eventRouter, buildNewSessionUpdate, buildSessionActivityEphemeral } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import { CanonicalUuidSchema, IdSchema, TagSchema, TokenSchema, EncryptedBlobSchema, EncryptedMetadataSchema } from "@/app/api/routes/_schemas";
import { afterTx, inTx } from "@/storage/inTx";
import {
    isUniqueConstraintError,
    MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
    MAX_SESSIONS_PER_ACCOUNT,
} from "@/app/limits/persistedResourceQuotas";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
    HistoryResponseLimitError,
    readBoundedMessageHistory,
    serializeBoundedMessageHistory,
} from '@/app/session/messageHistory';

const SessionCreateBodySchema = z.object({
    id: CanonicalUuidSchema.optional(),
    tag: TagSchema,
    metadata: EncryptedMetadataSchema,
    agentState: EncryptedBlobSchema.nullish(),
    dataEncryptionKey: TokenSchema.nullish(),
});

const BoundSessionCreateBodySchema = z.object({
    id: CanonicalUuidSchema,
    tag: TagSchema,
    metadata: EncryptedMetadataSchema,
    agentState: EncryptedBlobSchema.nullish(),
    dataEncryptionKey: TokenSchema.nullish(),
});

// Milliseconds through 9999-12-31T23:59:59Z. Keep user input inside the
// shared JavaScript/PostgreSQL timestamp range before constructing a Date.
const MAX_SESSION_CHANGED_SINCE_MS = 253_402_300_799_000;

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => {
                const sessionUpdatedAt = v.updatedAt.getTime();

                return {
                    id: v.id,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: sessionUpdatedAt,
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                    // The compatibility response shape retains this field even
                    // though session lists do not materialize message content.
                    lastMessage: null
                };
            })
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: TagSchema.optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().max(MAX_SESSION_CHANGED_SINCE_MS).optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    const handleCreateSession = async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.userId;
        const { id, tag, metadata, agentState, dataEncryptionKey } = SessionCreateBodySchema.parse(request.body);

        let result;
        try {
            result = await inTx(async (tx) => {
                // Idempotency comes before quota enforcement. A reconnect/restore of
                // an existing tag must keep working even for a legacy overflow account.
                const existing = await tx.session.findFirst({
                    where: { accountId: userId, tag }
                });
                if (existing) {
                    return { kind: 'session' as const, session: existing };
                }

                const [totalSessions, activeSessions] = await Promise.all([
                    tx.session.count({ where: { accountId: userId } }),
                    tx.session.count({ where: { accountId: userId, active: true } }),
                ]);
                if (totalSessions >= MAX_SESSIONS_PER_ACCOUNT) {
                    return { kind: 'total-limit' as const };
                }
                if (activeSessions >= MAX_ACTIVE_SESSIONS_PER_ACCOUNT) {
                    return { kind: 'active-limit' as const };
                }

                const updSeq = await allocateUserSeq(userId, tx);
                const session = await tx.session.create({
                    data: {
                        ...(id ? { id } : {}),
                        accountId: userId,
                        tag,
                        metadata,
                        agentState: agentState ?? null,
                        dataEncryptionKey: dataEncryptionKey
                            ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                            : undefined
                    }
                });
                const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
                afterTx(tx, () => {
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                });
                return { kind: 'session' as const, session };
            });
        } catch (error) {
            if (!isUniqueConstraintError(error)) {
                throw error;
            }
            // Some compatible database adapters surface a unique violation
            // rather than a serialization retry. Re-read only this account's
            // tag and treat the winner as the idempotent restore result.
            const existing = await db.session.findFirst({
                where: { accountId: userId, tag }
            });
            if (!existing) {
                return reply.code(409).send({
                    error: 'Session identifier conflict',
                    code: 'SESSION_ID_CONFLICT',
                });
            }
            result = { kind: 'session' as const, session: existing };
        }

        if (result.kind === 'total-limit') {
            return reply.code(409).send({
                error: 'Session limit reached',
                code: 'SESSION_LIMIT_REACHED',
                limit: MAX_SESSIONS_PER_ACCOUNT,
            });
        }
        if (result.kind === 'active-limit') {
            return reply.code(409).send({
                error: 'Active session limit reached',
                code: 'ACTIVE_SESSION_LIMIT_REACHED',
                limit: MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
            });
        }

        const session = result.session;
        return reply.send({
            session: {
                id: session.id,
                seq: session.seq,
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion,
                dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                active: session.active,
                activeAt: session.lastActiveAt.getTime(),
                createdAt: session.createdAt.getTime(),
                updatedAt: session.updatedAt.getTime(),
                lastMessage: null
            }
        });
    };

    // Legacy clients may omit the session coordinate. Current clients use the
    // v2 contract so an unsupported relay rejects the request before creating
    // an unreadable server-generated row.
    app.post('/v1/sessions', {
        schema: { body: SessionCreateBodySchema },
        preHandler: app.authenticate,
    }, handleCreateSession);

    app.post('/v2/sessions', {
        schema: { body: BoundSessionCreateBodySchema },
        preHandler: app.authenticate,
    }, handleCreateSession);

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: IdSchema
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        try {
            const page = await inTx((tx) => readBoundedMessageHistory(tx, {
                where: { sessionId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                limit: 150,
                mode: 'legacy',
            }));
            const serialized = serializeBoundedMessageHistory({
                messages: page.messages.map((message) => ({
                    id: message.id,
                    seq: message.seq,
                    content: message.content,
                    localId: message.localId,
                    createdAt: message.createdAt.getTime(),
                    updatedAt: message.updatedAt.getTime(),
                })),
            });
            return reply.type('application/json').send(serialized);
        } catch (error) {
            if (error instanceof HistoryResponseLimitError) {
                return reply.code(409).send({
                    error: 'Message history exceeds the legacy response limit',
                    code: error.code,
                });
            }
            throw error;
        }
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: userId },
            data: { active: false, lastActiveAt: new Date() }
        });

        if (result.count === 0) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(sessionId, false, Date.now(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: IdSchema
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}
