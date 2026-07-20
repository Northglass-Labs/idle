import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { allocateSessionSeqBatch, allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { z } from "zod";
import { type Fastify } from "../types";
import { IdSchema, EncryptedMessageContentSchema } from "@/app/api/routes/_schemas";
import { AUTHENTICATED_MESSAGE_BODY_LIMIT } from "../requestSecurity";
import { inTx } from "@/storage/inTx";
import { getMessageStorageQuotaStatus } from "@/app/limits/persistedResourceQuotas";
import { messageIngressLimiter } from '@/app/api/messageIngressLimit';
import {
    HistoryResponseLimitError,
    readBoundedMessageHistory,
    serializeBoundedMessageHistory,
} from '@/app/session/messageHistory';

// Pagination contract:
//   - after_seq=N  → forward sync: messages with seq > N, ordered ASC.
//                    Used by the client to pull anything new since the highest
//                    seq it has already seen.
//   - before_seq=N → backward paging: messages with seq < N, ordered DESC.
//                    Used by the client to lazy-load older history when the
//                    user scrolls up, so opening a long session does not block
//                    on fetching the entire history first.
// The two are mutually exclusive. With neither, the route defaults to
// `after_seq=0` (forward from the start) for backward compatibility.
const getMessagesQuerySchema = z.object({
    after_seq: z.coerce.number().int().min(0).optional(),
    before_seq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100)
}).refine(
    (data) => !(data.after_seq !== undefined && data.before_seq !== undefined),
    { message: "after_seq and before_seq are mutually exclusive" }
);

const PRISMA_INT_MAX = 2_147_483_647;

const sendMessagesBodySchema = z.object({
    messages: z.array(z.object({
        content: EncryptedMessageContentSchema,
        localId: IdSchema
    })).min(1).max(100)
});

type SelectedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type MessageIngressRequest = {
    raw: {
        once(event: 'aborted', listener: () => void): unknown;
        off(event: 'aborted', listener: () => void): unknown;
    };
};

const messageIngressLeases = new WeakMap<object, () => void>();

function releaseMessageIngress(request: MessageIngressRequest): void {
    messageIngressLeases.get(request)?.();
}

function trackMessageIngress(request: MessageIngressRequest, releaseReservation: () => void): void {
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        request.raw.off('aborted', release);
        messageIngressLeases.delete(request);
        releaseReservation();
    };
    messageIngressLeases.set(request, release);
    request.raw.once('aborted', release);
}

function toResponseMessage(message: SelectedMessage) {
    return {
        id: message.id,
        seq: message.seq,
        content: message.content,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

function toSendResponseMessage(message: Omit<SelectedMessage, "content">) {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: message.createdAt.getTime(),
        updatedAt: message.updatedAt.getTime()
    };
}

export function v3SessionRoutes(app: Fastify) {
    app.get('/v3/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: IdSchema
            }),
            querystring: getMessagesQuerySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { after_seq, before_seq, limit } = request.query;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Backward direction is opt-in via `before_seq`; everything else (no
        // params, or explicit `after_seq`) keeps the legacy forward semantics.
        const isBackward = before_seq !== undefined;
        const where = isBackward
            // Clients use MAX_SAFE_INTEGER as a "newest page" sentinel. Do not
            // pass that through to Prisma's signed 32-bit Int filter.
            ? before_seq > PRISMA_INT_MAX
                ? { sessionId }
                : { sessionId, seq: { lt: before_seq } }
            : { sessionId, seq: { gt: Math.min(after_seq ?? 0, PRISMA_INT_MAX) } };
        const orderBy = isBackward
            ? { seq: 'desc' as const }
            : { seq: 'asc' as const };

        try {
            const page = await inTx((tx) => readBoundedMessageHistory(tx, {
                where,
                orderBy,
                limit,
                mode: 'paginated',
            }));
            const serialized = serializeBoundedMessageHistory({
                messages: page.messages.map(toResponseMessage),
                hasMore: page.hasMore,
            });
            return reply.type('application/json').send(serialized);
        } catch (error) {
            if (error instanceof HistoryResponseLimitError) {
                return reply.code(409).send({
                    error: 'Message history exceeds the response limit',
                    code: error.code,
                });
            }
            throw error;
        }
    });

    app.post('/v3/sessions/:sessionId/messages', {
        // Authenticate and reserve the full route-local body allowance before
        // Fastify buffers encrypted content. Content-Length is not trusted for
        // the reservation because a client can understate or omit it.
        bodyLimit: AUTHENTICATED_MESSAGE_BODY_LIMIT,
        onRequest: app.authenticate,
        preParsing: async (request, reply, payload) => {
            const declaredLength = request.headers['content-length'];
            if (
                declaredLength !== undefined
                && (
                    !/^\d+$/.test(declaredLength)
                    || !Number.isSafeInteger(Number(declaredLength))
                    || Number(declaredLength) > AUTHENTICATED_MESSAGE_BODY_LIMIT
                )
            ) {
                await reply.code(413).send({
                    error: 'Message request body is too large',
                    code: 'MESSAGE_BODY_LIMIT_REACHED',
                });
                return payload;
            }

            const { sessionId } = request.params as { sessionId: string };
            const ownedSession = await db.session.findFirst({
                where: { id: sessionId, accountId: request.userId },
                select: { id: true },
            });
            if (!ownedSession) {
                await reply.code(404).send({ error: 'Session not found' });
                return payload;
            }

            const release = messageIngressLimiter.tryAcquire(
                request.userId,
                AUTHENTICATED_MESSAGE_BODY_LIMIT,
            );
            if (!release) {
                await reply.code(429).send({
                    error: 'Too many message uploads are in progress',
                    code: 'MESSAGE_INGRESS_BUSY',
                });
                return payload;
            }
            trackMessageIngress(request, release);
            return payload;
        },
        onError: async (request) => {
            releaseMessageIngress(request);
        },
        onResponse: async (request) => {
            releaseMessageIngress(request);
        },
        schema: {
            params: z.object({
                sessionId: IdSchema
            }),
            body: sendMessagesBodySchema
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { messages } = request.body;

        const firstMessageByLocalId = new Map<string, { localId: string; content: string }>();
        for (const message of messages) {
            if (!firstMessageByLocalId.has(message.localId)) {
                firstMessageByLocalId.set(message.localId, message);
            }
        }

        const uniqueMessages = Array.from(firstMessageByLocalId.values());
        const contentByLocalId = new Map(uniqueMessages.map((message) => [message.localId, message.content]));

        const txResult = await inTx(async (tx) => {
            const ownedSession = await tx.session.findFirst({
                where: { id: sessionId, accountId: userId },
                select: { id: true },
            });
            if (!ownedSession) {
                return { kind: 'missing' as const };
            }

            const localIds = uniqueMessages.map((message) => message.localId);
            const existing = await tx.sessionMessage.findMany({
                where: {
                    sessionId,
                    localId: { in: localIds }
                },
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            const existingByLocalId = new Map<string, Omit<SelectedMessage, 'content'>>();
            for (const message of existing) {
                if (message.localId) {
                    existingByLocalId.set(message.localId, message);
                }
            }

            const newMessages = uniqueMessages.filter((message) => !existingByLocalId.has(message.localId));
            const newContentBytes = newMessages.reduce(
                (total, message) => total + Buffer.byteLength(message.content, 'utf8'),
                0,
            );
            const quotaStatus = await getMessageStorageQuotaStatus(
                tx,
                userId,
                sessionId,
                newMessages.length,
                newContentBytes,
            );
            if (quotaStatus !== 'ok') {
                return { kind: 'limit' as const, quotaStatus };
            }
            const seqs = await allocateSessionSeqBatch(sessionId, newMessages.length, tx);

            const createdMessages: Omit<SelectedMessage, 'content'>[] = [];
            for (let i = 0; i < newMessages.length; i += 1) {
                const message = newMessages[i];
                const createdMessage = await tx.sessionMessage.create({
                    data: {
                        sessionId,
                        seq: seqs[i],
                        content: {
                            t: 'encrypted',
                            c: message.content
                        },
                        contentBytes: Buffer.byteLength(message.content, 'utf8'),
                        localId: message.localId
                    },
                    select: {
                        id: true,
                        seq: true,
                        content: true,
                        localId: true,
                        createdAt: true,
                        updatedAt: true
                    }
                });
                createdMessages.push(createdMessage);
            }

            const responseMessages = [...existing, ...createdMessages].sort((a, b) => a.seq - b.seq);

            return {
                kind: 'ok' as const,
                responseMessages,
                createdMessages
            };
        });

        if (txResult.kind === 'missing') {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (txResult.kind === 'limit') {
            return reply.code(429).send({
                error: 'Message storage limit reached',
                code: 'MESSAGE_LIMIT_REACHED',
                scope: txResult.quotaStatus.startsWith('session-') ? 'session' : 'account',
            });
        }

        for (const message of txResult.createdMessages) {
            const content = message.localId ? contentByLocalId.get(message.localId) : null;
            if (!content) {
                continue;
            }
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildNewMessageUpdate({
                ...message,
                content: {
                    t: 'encrypted',
                    c: content
                }
            }, sessionId, updSeq, randomKeyNaked(12));

            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId }
            });
        }

        return reply.send({
            messages: txResult.responseMessages.map(toSendResponseMessage)
        });
    });
}
