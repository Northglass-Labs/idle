import { getMetricsLabelsFromSocket, machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import { activityCache } from "@/app/presence/sessionCache";
import { buildMachineActivityEphemeral, buildUpdateMachineUpdate, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { MAX_ACTIVE_MACHINES_PER_ACCOUNT } from "@/app/limits/persistedResourceQuotas";
import { onAuthorizedSocketEvent } from "./socketScope";
import {
    MachineAliveDataSchema,
    MachineMetadataUpdateDataSchema,
    MachineStateUpdateDataSchema,
} from "./liveUpdateSchemas";

function logMachineUpdateFailure(_message: string, error: unknown): void {
    log({
        module: 'websocket',
        level: 'error',
        failureType: error instanceof Error ? 'error' : typeof error,
    }, 'Machine update failed');
}

export function machineUpdateHandler(userId: string, socket: Socket, connection: ClientConnection) {
    const labels = getMetricsLabelsFromSocket(socket);

    onAuthorizedSocketEvent(socket, connection, 'machine-alive', async (data: unknown) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive', ...labels });
            machineAliveEventsCounter.inc();

            const parsed = MachineAliveDataSchema.safeParse(data);
            if (!parsed.success) return;
            const { machineId, time } = parsed.data;

            let t = time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            // Check machine validity using cache
            const isValid = await activityCache.isMachineValid(machineId, userId);
            if (!isValid) {
                return;
            }

            // Queue database update (will only update if time difference is significant)
            activityCache.queueMachineUpdate(machineId, t);

            const machineActivity = buildMachineActivityEphemeral(machineId, true, t);
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            logMachineUpdateFailure('Machine activity update failed', error);
        }
    });

    // Machine metadata update with optimistic concurrency control
    onAuthorizedSocketEvent(socket, connection, 'machine-update-metadata', async (data: unknown, callback?: (response: any) => void) => {
        const respond = typeof callback === 'function' ? callback : undefined;
        try {
            const parsed = MachineMetadataUpdateDataSchema.safeParse(data);
            if (!parsed.success) {
                respond?.({ result: 'error', message: 'Invalid parameters' });
                return;
            }
            const { machineId, metadata, expectedVersion } = parsed.data;

            // Resolve machine
            const machine = await db.machine.findFirst({
                where: {
                    accountId: userId,
                    id: machineId
                }
            });
            if (!machine) {
                respond?.({ result: 'error', message: 'Machine not found' });
                return;
            }

            // Check version
            if (machine.metadataVersion !== expectedVersion) {
                respond?.({
                    result: 'version-mismatch',
                    version: machine.metadataVersion,
                    metadata: machine.metadata
                });
                return;
            }

            // Update metadata with atomic version check
            const { count } = await db.machine.updateMany({
                where: {
                    accountId: userId,
                    id: machineId,
                    metadataVersion: expectedVersion  // Atomic CAS
                },
                data: {
                    metadata: metadata,
                    metadataVersion: expectedVersion + 1
                    // NOT updating active or lastActiveAt here
                }
            });

            if (count === 0) {
                // Re-fetch current version
                const current = await db.machine.findFirst({
                    where: {
                        accountId: userId,
                        id: machineId
                    }
                });
                respond?.({
                    result: 'version-mismatch',
                    version: current?.metadataVersion || 0,
                    metadata: current?.metadata
                });
                return;
            }

            // Generate machine metadata update
            const updSeq = await allocateUserSeq(userId);
            const metadataUpdate = {
                value: metadata,
                version: expectedVersion + 1
            };
            const updatePayload = buildUpdateMachineUpdate(machineId, updSeq, randomKeyNaked(12), metadataUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId }
            });

            // Send success response with new version
            respond?.({
                result: 'success',
                version: expectedVersion + 1,
                metadata: metadata
            });
        } catch (error) {
            logMachineUpdateFailure('Machine metadata update failed', error);
            respond?.({ result: 'error', message: 'Internal error' });
        }
    });

    // Machine daemon state update with optimistic concurrency control
    onAuthorizedSocketEvent(socket, connection, 'machine-update-state', async (data: unknown, callback?: (response: any) => void) => {
        const respond = typeof callback === 'function' ? callback : undefined;
        try {
            const parsed = MachineStateUpdateDataSchema.safeParse(data);
            if (!parsed.success) {
                respond?.({ result: 'error', message: 'Invalid parameters' });
                return;
            }
            const { machineId, daemonState, expectedVersion } = parsed.data;

            const result = await inTx(async (tx) => {
                const machine = await tx.machine.findFirst({
                    where: { accountId: userId, id: machineId }
                });
                if (!machine) {
                    return { kind: 'missing' as const };
                }

                if (machine.daemonStateVersion !== expectedVersion) {
                    return {
                        kind: 'version-mismatch' as const,
                        version: machine.daemonStateVersion,
                        daemonState: machine.daemonState,
                    };
                }

                // Existing active machines remain usable for legacy accounts
                // over the cap. Only an inactive-to-active transition consumes
                // capacity, and the count/update share Serializable isolation.
                if (!machine.active) {
                    const activeMachines = await tx.machine.count({
                        where: { accountId: userId, active: true }
                    });
                    if (activeMachines >= MAX_ACTIVE_MACHINES_PER_ACCOUNT) {
                        return { kind: 'active-limit' as const };
                    }
                }

                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: userId,
                        id: machineId,
                        daemonStateVersion: expectedVersion,
                        active: machine.active,
                    },
                    data: {
                        daemonState,
                        daemonStateVersion: expectedVersion + 1,
                        active: true,
                        lastActiveAt: new Date()
                    }
                });

                if (count === 0) {
                    const current = await tx.machine.findFirst({
                        where: { accountId: userId, id: machineId }
                    });
                    return {
                        kind: 'version-mismatch' as const,
                        version: current?.daemonStateVersion || 0,
                        daemonState: current?.daemonState ?? null,
                    };
                }

                const updSeq = await allocateUserSeq(userId, tx);
                const daemonStateUpdate = {
                    value: daemonState,
                    version: expectedVersion + 1
                };
                const updatePayload = buildUpdateMachineUpdate(
                    machineId,
                    updSeq,
                    randomKeyNaked(12),
                    undefined,
                    daemonStateUpdate,
                );
                afterTx(tx, () => {
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'machine-scoped-only', machineId }
                    });
                });
                return { kind: 'success' as const };
            });

            if (result.kind === 'missing') {
                respond?.({ result: 'error', message: 'Machine not found' });
                return;
            }
            if (result.kind === 'active-limit') {
                respond?.({
                    result: 'error',
                    code: 'ACTIVE_MACHINE_LIMIT_REACHED',
                    message: 'Active machine limit reached',
                    limit: MAX_ACTIVE_MACHINES_PER_ACCOUNT,
                });
                return;
            }
            if (result.kind === 'version-mismatch') {
                respond?.({
                    result: 'version-mismatch',
                    version: result.version,
                    daemonState: result.daemonState
                });
                return;
            }

            // Send success response with new version
            respond?.({
                result: 'success',
                version: expectedVersion + 1,
                daemonState: daemonState
            });
        } catch (error) {
            logMachineUpdateFailure('Machine state update failed', error);
            respond?.({ result: 'error', message: 'Internal error' });
        }
    });
}
