import { getMetricsLabelsFromSocket, sessionAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildNewMessageUpdate, buildSessionActivityEphemeral, buildUpdateSessionUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import {
    getMessageStorageQuotaStatus,
    reactivateSessionWithinQuota,
} from "@/app/limits/persistedResourceQuotas";
import { AsyncLock } from "@/utils/lock";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { Socket } from "socket.io";
import { z } from "zod";
import { EncryptedMessageContentSchema, IdSchema } from "@/app/api/routes/_schemas";
import { onAuthorizedSocketEvent } from "./socketScope";
import {
    SessionAliveDataSchema,
    SessionEndDataSchema,
    SessionMetadataUpdateDataSchema,
    SessionStateUpdateDataSchema,
} from "./liveUpdateSchemas";

const LegacySocketMessageSchema = z.object({
    sid: IdSchema,
    message: EncryptedMessageContentSchema,
    localId: IdSchema.nullish(),
}).strict();

function logSessionUpdateFailure(_message: string, error: unknown): void {
    log({
        module: 'websocket',
        level: 'error',
        failureType: error instanceof Error ? 'error' : typeof error,
    }, 'Session update failed');
}

export function sessionUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);
    onAuthorizedSocketEvent(socket, connection, 'update-metadata', async (data: unknown, callback?: (response: any) => void) => {
        const respond = typeof callback === 'function' ? callback : undefined;
        try {
            const parsed = SessionMetadataUpdateDataSchema.safeParse(data);
            if (!parsed.success) {
                respond?.({ result: 'error' });
                return;
            }
            const { sid, metadata, expectedVersion } = parsed.data;

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Check version
            if (session.metadataVersion !== expectedVersion) {
                respond?.({ result: 'version-mismatch', version: session.metadataVersion, metadata: session.metadata });
                return null;
            }

            // Update metadata
            const { count } = await db.session.updateMany({
                where: { id: sid, accountId: userId, metadataVersion: expectedVersion },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                const current = await db.session.findUnique({
                    where: { id: sid, accountId: userId },
                });
                if (!current) {
                    respond?.({ result: 'error' });
                    return null;
                }
                respond?.({ result: 'version-mismatch', version: current.metadataVersion, metadata: current.metadata });
                return null;
            }

            // Generate session metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            respond?.({ result: 'success', version: expectedVersion + 1, metadata: metadata });
        } catch (error) {
            logSessionUpdateFailure('Session metadata update failed', error);
            respond?.({ result: 'error' });
        }
    });

    onAuthorizedSocketEvent(socket, connection, 'update-state', async (data: unknown, callback?: (response: any) => void) => {
        const respond = typeof callback === 'function' ? callback : undefined;
        try {
            const parsed = SessionStateUpdateDataSchema.safeParse(data);
            if (!parsed.success) {
                respond?.({ result: 'error' });
                return;
            }
            const { sid, agentState, expectedVersion } = parsed.data;

            // Resolve session
            const session = await db.session.findUnique({
                where: {
                    id: sid,
                    accountId: userId
                }
            });
            if (!session) {
                respond?.({ result: 'error' });
                return null;
            }

            // Check version
            if (session.agentStateVersion !== expectedVersion) {
                respond?.({ result: 'version-mismatch', version: session.agentStateVersion, agentState: session.agentState });
                return null;
            }

            // Update agent state
            const { count } = await db.session.updateMany({
                where: { id: sid, accountId: userId, agentStateVersion: expectedVersion },
                data: {
                    agentState: agentState,
                    agentStateVersion: expectedVersion + 1
                }
            });
            if (count === 0) {
                const current = await db.session.findUnique({
                    where: { id: sid, accountId: userId },
                });
                if (!current) {
                    respond?.({ result: 'error' });
                    return null;
                }
                respond?.({ result: 'version-mismatch', version: current.agentStateVersion, agentState: current.agentState });
                return null;
            }

            // Generate session agent state update
            const updSeq = await allocateUserSeq(userId);
            const agentStateUpdate = {
                value: agentState,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateSessionUpdate(sid, updSeq, randomKeyNaked(12), undefined, agentStateUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'all-interested-in-session', sessionId: sid }
            });

            // Send success response with new version via callback
            respond?.({ result: 'success', version: expectedVersion + 1, agentState: agentState });
        } catch (error) {
            logSessionUpdateFailure('Session state update failed', error);
            respond?.({ result: 'error' });
        }
    });
    onAuthorizedSocketEvent(socket, connection, 'session-alive', async (data: unknown) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive', ...labels });
            sessionAliveEventsCounter.inc();

            const parsed = SessionAliveDataSchema.safeParse(data);
            if (!parsed.success) return;
            const { sid, time, thinking } = parsed.data;

            let t = time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            // Check session validity using cache
            const isValid = await activityCache.isSessionValid(sid, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueSessionUpdate(sid, t);

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, true, t, thinking || false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            logSessionUpdateFailure('Session activity update failed', error);
        }
    });

    const receiveMessageLock = new AsyncLock();
    onAuthorizedSocketEvent(socket, connection, 'message', async (data: any) => {
        await receiveMessageLock.inLock(async () => {
            try {
                websocketEventsCounter.inc({ event_type: 'message', ...labels });
                const parsed = LegacySocketMessageSchema.safeParse(data);
                if (!parsed.success) {
                    return;
                }
                const { sid, message } = parsed.data;
                const localId = parsed.data.localId ?? null;

                const writeResult = await inTx(async (tx) => {
                    const session = await tx.session.findUnique({
                        where: { id: sid, accountId: userId }
                    });
                    if (!session) {
                        return { kind: 'missing' as const };
                    }

                    // Preserve idempotent legacy retries even for an account
                    // that has reached its durable row or byte budget.
                    if (localId) {
                        const existing = await tx.sessionMessage.findFirst({
                            where: { sessionId: sid, localId }
                        });
                        if (existing) {
                            return { kind: 'existing' as const };
                        }
                    }

                    const contentBytes = Buffer.byteLength(message, 'utf8');
                    const quotaStatus = await getMessageStorageQuotaStatus(tx, userId, sid, 1, contentBytes);
                    if (quotaStatus !== 'ok') {
                        return { kind: 'limit' as const, quotaStatus };
                    }

                    const updSeq = await allocateUserSeq(userId, tx);
                    const msgSeq = await allocateSessionSeq(sid, tx);
                    const msg = await tx.sessionMessage.create({
                        data: {
                            sessionId: sid,
                            seq: msgSeq,
                            content: {
                                t: 'encrypted',
                                c: message
                            } satisfies PrismaJson.SessionMessageContent,
                            contentBytes,
                            localId
                        }
                    });

                    // A durable message may reactivate the session, but the
                    // active-session cap never causes the message itself to be
                    // lost.
                    await reactivateSessionWithinQuota(tx, userId, sid, Date.now());
                    return { kind: 'created' as const, msg, updSeq };
                });

                if (writeResult.kind === 'limit') {
                    log({ module: 'websocket', level: 'warn', quotaStatus: writeResult.quotaStatus }, 'Message storage limit reached');
                    return;
                }
                if (writeResult.kind !== 'created') {
                    return;
                }

                // Emit new message update to relevant clients
                const updatePayload = buildNewMessageUpdate(writeResult.msg, sid, writeResult.updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: connection
                });
            } catch (error) {
                logSessionUpdateFailure('Session message update failed', error);
            }
        });
    });

    onAuthorizedSocketEvent(socket, connection, 'session-end', async (data: unknown) => {
        try {
            const parsed = SessionEndDataSchema.safeParse(data);
            if (!parsed.success) return;
            const { sid, time } = parsed.data;
            let t = time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                return;
            }

            // Resolve session
            const session = await db.session.findUnique({
                where: { id: sid, accountId: userId }
            });
            if (!session) {
                return;
            }

            // Update last active at
            await db.session.update({
                where: { id: sid },
                data: { lastActiveAt: new Date(t), active: false }
            });

            // Emit session activity update
            const sessionActivity = buildSessionActivityEphemeral(sid, false, t, false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            logSessionUpdateFailure('Session end update failed', error);
        }
    });

}
