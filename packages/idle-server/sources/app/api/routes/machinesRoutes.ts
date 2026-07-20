import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { inTx, afterTx } from "@/storage/inTx";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewMachineUpdate, buildUpdateMachineUpdate, buildDeleteMachineUpdate } from "@/app/events/eventRouter";
import { IdSchema, TokenSchema, EncryptedMetadataSchema, EncryptedBlobSchema } from "@/app/api/routes/_schemas";
import {
    isUniqueConstraintError,
    MACHINE_LIST_LIMIT,
    MAX_MACHINES_PER_ACCOUNT,
} from "@/app/limits/persistedResourceQuotas";

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: IdSchema,
                metadata: EncryptedMetadataSchema, // Encrypted metadata
                daemonState: EncryptedBlobSchema.optional(), // Encrypted daemon state
                dataEncryptionKey: TokenSchema.nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        let result;
        try {
            result = await inTx(async (tx) => {
                // Preserve reconnect idempotency before checking the quota.
                const existing = await tx.machine.findFirst({
                    where: { accountId: userId, id }
                });
                if (existing) {
                    return { kind: 'machine' as const, machine: existing };
                }

                const machineCount = await tx.machine.count({ where: { accountId: userId } });
                if (machineCount >= MAX_MACHINES_PER_ACCOUNT) {
                    return { kind: 'limit' as const };
                }

                const machine = await tx.machine.create({
                    data: {
                        id,
                        accountId: userId,
                        metadata,
                        metadataVersion: 1,
                        daemonState: daemonState || null,
                        daemonStateVersion: daemonState ? 1 : 0,
                        dataEncryptionKey: dataEncryptionKey
                            ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                            : undefined,
                        active: false,
                    }
                });

                const updSeq1 = await allocateUserSeq(userId, tx);
                const updSeq2 = await allocateUserSeq(userId, tx);
                const newMachinePayload = buildNewMachineUpdate(machine, updSeq1, randomKeyNaked(12));
                const machineMetadata = { version: 1, value: metadata };
                const updatePayload = buildUpdateMachineUpdate(machine.id, updSeq2, randomKeyNaked(12), machineMetadata);
                afterTx(tx, () => {
                    eventRouter.emitUpdate({
                        userId,
                        payload: newMachinePayload,
                        recipientFilter: { type: 'user-scoped-only' }
                    });
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId: machine.id }
                    });
                });
                return { kind: 'machine' as const, machine };
            });
        } catch (error) {
            // Machine.id is globally unique in the current schema. An ID owned
            // by a different account is a persistent ownership conflict, not a
            // transient server failure or an invitation to disclose its owner.
            if (isUniqueConstraintError(error)) {
                const existing = await db.machine.findFirst({
                    where: { accountId: userId, id }
                });
                if (existing) {
                    result = { kind: 'machine' as const, machine: existing };
                } else {
                    return reply.code(409).send({
                        error: 'Machine ID is already registered',
                        code: 'MACHINE_ID_CONFLICT',
                    });
                }
            } else {
                throw error;
            }
        }

        if (result.kind === 'limit') {
            return reply.code(409).send({
                error: 'Machine limit reached',
                code: 'MACHINE_LIMIT_REACHED',
                limit: MAX_MACHINES_PER_ACCOUNT,
            });
        }

        const machine = result.machine;
        return reply.send({
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        });
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' },
            take: MACHINE_LIST_LIMIT,
        });

        return machines.map(m => ({
            id: m.id,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            dataEncryptionKey: m.dataEncryptionKey ? Buffer.from(m.dataEncryptionKey).toString('base64') : null,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: IdSchema
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

    // DELETE /v1/machines/:id - Remove a machine and its access keys.
    // Sessions spawned by this machine are preserved so history is not lost.
    app.delete('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const deleted = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: { accountId: userId, id }
            });
            if (!machine) {
                return false;
            }

            await tx.accessKey.deleteMany({
                where: { accountId: userId, machineId: id }
            });

            await tx.machine.delete({
                where: { id }
            });

            const updSeq = await allocateUserSeq(userId, tx);
            const updatePayload = buildDeleteMachineUpdate(id, updSeq, randomKeyNaked(12), machine.createdAt);
            afterTx(tx, () => {
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
                log({ module: 'machines' }, 'Machine deleted');
            });

            return true;
        });

        // Always sweep after the durable transaction, including when the row
        // is already absent. That makes a retry repair a prior adapter failure
        // without widening revocation to unrelated account sockets.
        await eventRouter.disconnectMachineConnections(userId, id);

        if (!deleted) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return reply.send({ success: true });
    });

}
