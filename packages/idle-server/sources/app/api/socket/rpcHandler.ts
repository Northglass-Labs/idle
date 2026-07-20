import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import type { RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import { Counter, register } from 'prom-client';
import { RpcCallDataSchema, RpcRegisterDataSchema, RpcUnregisterDataSchema } from "./rpcSchemas";
import type { ClientConnection } from "@/app/events/eventRouter";
import {
    canRegisterRpcMethod,
    isBoundedRpcResult,
    rpcInFlightLimiter,
    rpcRegistrationLimiter,
} from "./rpcSecurity";
import { onAuthorizedSocketEvent } from "./socketScope";
import { db } from "@/storage/db";
import {
    recordRpcLookupRetries,
    recordRpcResult,
    type RpcMetricResult,
} from './rpcMetrics';

// RPC routing uses Socket.IO rooms. A daemon registering method M for user U
// joins room `rpc:U:M`. Callers look the daemon up cross-replica via
// io.in(room).fetchSockets() — supplied by the cluster adapter (the streams
// adapter inherits from ClusterAdapterWithHeartbeat, which implements both
// fetchSockets-cross-replica and broadcast-ack-cross-replica).
//
// No Redis keys, no TTLs, no Lua, no keep-alive refresh path. On disconnect
// Socket.IO removes the socket from all rooms automatically.

const RPC_ROOM_PREFIX = 'rpc:';
const RPC_CALL_TIMEOUT_MS = 30_000;
const RPC_PRESENCE_POLL_MS = 2_000;
// Timeouts for cross-replica fetchSockets during the reconnect grace window.
// Exponential backoff: 2s → 4s → 8s. Reduces stream pressure under load
// (fewer timed-out requests flooding the stream) while giving later attempts
// more time to succeed when Redis is slow.
const RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000];
// Timeout for in-flight presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS
// so a dead replica doesn't stall each poll for the full adapter heartbeatTimeout
// (10s). 500ms keeps daemon-death detection responsive (~1s).
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
// How long an rpc-call waits for the daemon socket to appear in the room when
// the room is empty at call time (e.g. brief daemon reconnect window). With
// exponential backoff (2s, 4s, 8s) + 200ms sleep, iterations take 2.2s, 4.2s,
// 8.2s. 15s gives ~3 iterations with increasing timeouts — fewer requests
// under load while still catching a daemon mid-reconnect.
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;

const rpcFetchSocketsTimeouts = new Counter({
    name: 'rpc_fetchsockets_timeouts_total',
    help: 'Cross-replica fetchSockets timeouts by context',
    labelNames: ['context'] as const,
    registers: [register]
});

function rpcRoom(userId: string, method: string): string {
    return `${RPC_ROOM_PREFIX}${userId}:${method}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RoomSockets = RemoteSocket<DefaultEventsMap, any>[];

type RpcTarget = RoomSockets[number];

async function isRpcTargetAuthorizationCurrent(
    userId: string,
    method: string,
    target: RpcTarget,
): Promise<boolean> {
    const data = target.data as Record<string, unknown>;
    if (
        data.userId !== userId
        || data.rpcRegistrationAuthorized !== true
        || typeof data.accountAuthorizationGeneration !== 'number'
        || !Number.isSafeInteger(data.accountAuthorizationGeneration)
        || typeof data.authorizationGeneration !== 'number'
        || !Number.isSafeInteger(data.authorizationGeneration)
    ) {
        return false;
    }

    const account = await db.account.findUnique({
        where: { id: userId },
        select: { authVersion: true, authSuspendedAt: true },
    });
    if (
        !account
        || account.authSuspendedAt !== null
        || account.authVersion !== data.accountAuthorizationGeneration
    ) {
        return false;
    }

    if (data.clientType === 'session-scoped' && typeof data.sessionId === 'string') {
        const scope = {
            connectionType: 'session-scoped' as const,
            sessionId: data.sessionId,
            rpcRegistrationAuthorized: true,
        };
        if (!canRegisterRpcMethod(scope, method)) return false;
        const session = await db.session.findFirst({
            where: { accountId: userId, id: data.sessionId },
            select: { createdAt: true },
        });
        return session?.createdAt.getTime() === data.authorizationGeneration;
    }

    if (data.clientType === 'machine-scoped' && typeof data.machineId === 'string') {
        const scope = {
            connectionType: 'machine-scoped' as const,
            machineId: data.machineId,
            rpcRegistrationAuthorized: true,
        };
        if (!canRegisterRpcMethod(scope, method)) return false;
        const machine = await db.machine.findFirst({
            where: { accountId: userId, id: data.machineId },
            select: { createdAt: true },
        });
        return machine?.createdAt.getTime() === data.authorizationGeneration;
    }

    return false;
}

async function ensureRpcTargetAuthorizationCurrent(
    userId: string,
    method: string,
    target: RpcTarget,
): Promise<boolean> {
    let isCurrent = false;
    try {
        isCurrent = await isRpcTargetAuthorizationCurrent(userId, method, target);
    } catch {
        // Durable authorization uncertainty must fail closed.
    }
    if (isCurrent) return true;

    try {
        target.disconnect(true);
    } catch {
        // The caller still fails closed even if adapter eviction is delayed.
    }
    return false;
}

async function retainCurrentRpcTargets(
    userId: string,
    method: string,
    targets: RoomSockets,
): Promise<RoomSockets> {
    const current = await Promise.all(targets.map((target) =>
        ensureRpcTargetAuthorizationCurrent(userId, method, target)
    ));
    return targets.filter((_target, index) => current[index]);
}

/**
 * fetchSockets(room) wrapped with a caller-specified timeout. Returns `[]`
 * and logs on failure (cluster-adapter request timeout, peer replica
 * unresponsive). Use RPC_LOOKUP_FETCH_TIMEOUT_MS for daemon lookups (initial
 * + grace window) and RPC_PRESENCE_FETCH_TIMEOUT_MS for in-flight presence
 * polling.
 */
async function fetchRoomSockets(io: Server, room: string, timeoutMs: number, context: 'lookup' | 'presence' = 'lookup'): Promise<RoomSockets> {
    try {
        return await io.in(room)
            .timeout(timeoutMs)
            .fetchSockets();
    } catch (error) {
        rpcFetchSocketsTimeouts.inc({ context });
        log({
            module: 'websocket',
            level: 'warn',
            rpcContext: context,
            timeoutMs,
            failureType: error instanceof Error ? 'error' : typeof error,
        }, 'RPC socket lookup failed');
        return [];
    }
}

/**
 * Poll fetchRoomSockets until it returns at least one socket OR `maxMs`
 * elapses. Uses exponential backoff on fetch timeouts (2s, 4s, 8s) to
 * reduce stream pressure when Redis is slow — fewer requests in flight
 * means less amplification of the timeout → retry → timeout spiral.
 */
async function waitForRoomMember(io: Server, room: string, maxMs: number, method: string): Promise<RoomSockets> {
    const deadline = Date.now() + maxMs;
    let polls = 0;
    while (true) {
        const timeoutMs = RPC_LOOKUP_FETCH_TIMEOUTS_MS[Math.min(polls, RPC_LOOKUP_FETCH_TIMEOUTS_MS.length - 1)];
        const sockets = await fetchRoomSockets(io, room, timeoutMs);
        if (sockets.length > 0) {
            recordRpcLookupRetries(method, polls);
            return sockets;
        }
        if (Date.now() >= deadline) {
            recordRpcLookupRetries(method, polls);
            return sockets;
        }
        polls++;
        await sleep(RPC_RECONNECT_POLL_MS);
    }
}

export function rpcHandler(userId: string, socket: Socket, io: Server, connection: ClientConnection) {
    const registrationLease = rpcRegistrationLimiter.createLease(userId);
    const inFlightLease = rpcInFlightLimiter.createLease(userId);

    onAuthorizedSocketEvent(socket, connection, 'rpc-register', (data: unknown) => {
        try {
            // Idle hardening: schema-validate before use — method is interpolated
            // into a Socket.IO room name, so it must stay strictly bounded.
            const parsed = RpcRegisterDataSchema.safeParse(data);
            if (!parsed.success) {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }
            const { method } = parsed.data;
            if (!canRegisterRpcMethod(connection, method)) {
                socket.emit('rpc-error', { type: 'register', error: 'RPC method is not authorized for this socket scope' });
                return;
            }
            const outcome = registrationLease.register(method);
            if (outcome === 'socket-limit' || outcome === 'account-limit') {
                socket.emit('rpc-error', { type: 'register', error: 'RPC registration limit exceeded' });
                return;
            }
            socket.join(rpcRoom(userId, method));
            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({
                module: 'websocket',
                level: 'error',
                failureType: error instanceof Error ? 'error' : typeof error,
            }, 'RPC registration failed');
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    onAuthorizedSocketEvent(socket, connection, 'rpc-unregister', (data: unknown) => {
        try {
            const parsed = RpcUnregisterDataSchema.safeParse(data);
            if (!parsed.success) {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }
            const { method } = parsed.data;
            if (!canRegisterRpcMethod(connection, method)) {
                socket.emit('rpc-error', { type: 'unregister', error: 'RPC method is not authorized for this socket scope' });
                return;
            }
            if (!registrationLease.unregister(method)) {
                socket.emit('rpc-error', { type: 'unregister', error: 'RPC method is not registered by this socket' });
                return;
            }
            socket.leave(rpcRoom(userId, method));
            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({
                module: 'websocket',
                level: 'error',
                failureType: error instanceof Error ? 'error' : typeof error,
            }, 'RPC unregistration failed');
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    onAuthorizedSocketEvent(socket, connection, 'rpc-call', async (data: unknown, callback: (response: any) => void) => {
        const startTime = Date.now();
        let releaseInFlight: (() => void) | null = null;
        // Idle hardening: schema-validate the whole payload up front.
        const parsedCall = RpcCallDataSchema.safeParse(data);
        const method = parsedCall.success ? parsedCall.data.method : undefined;
        const params = parsedCall.success ? parsedCall.data.params : undefined;

        const finish = (result: RpcMetricResult) => {
            const durationSec = (Date.now() - startTime) / 1000;
            recordRpcResult(method, result, durationSec);
        };

        try {
            if (!parsedCall.success || !method) {
                finish('invalid_params');
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }
            if (connection.connectionType !== 'user-scoped') {
                finish('unauthorized_caller');
                callback?.({ ok: false, error: 'RPC calls require a user-scoped socket' });
                return;
            }

            releaseInFlight = inFlightLease.tryAcquire();
            if (!releaseInFlight) {
                finish('busy');
                callback?.({ ok: false, error: 'Too many RPC calls in progress' });
                return;
            }

            // 1. Find the daemon socket(s) cross-replica via the adapter.
            // If the room is empty OR fetchSockets fails (peer replica
            // unresponsive — fetchRoomSockets logs and returns []) fall
            // through to the wait-for-reconnect grace window.
            const room = rpcRoom(userId, method);
            let targets = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUTS_MS[0]);
            if (targets.length === 0) {
                targets = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS, method);
            }
            // Validate every occupant before deciding whether the method is
            // ambiguous. A deleted generation can share the legacy room name
            // with a replacement object until adapter eviction completes; it
            // must be removed, not allowed to deny service to the valid one.
            targets = await retainCurrentRpcTargets(userId, method, targets);

            if (targets.length === 0) {
                finish('not_available');
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }
            if (targets.length > 1) {
                log({ module: 'websocket', level: 'warn', targetCount: targets.length },
                    'Ambiguous RPC target rejected');
                finish('ambiguous_target');
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }

            const target = targets[0];
            if (target.id === socket.id) {
                finish('self_call');
                callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                return;
            }

            // 2. Single-target emit with timeout — works cross-replica via adapter.
            //
            // Race against a presence poll that aborts fast if the target leaves
            // the room. WHY: emitWithAck has no idea the target socket is dead;
            // when the daemon's pod gets killed mid-call, the cluster adapter's
            // outgoing BROADCAST request is queued waiting for a BROADCAST_ACK
            // that will never come, and the request only times out at the user-
            // set RPC_CALL_TIMEOUT_MS (30s). Heartbeat-based pod liveness
            // detection in the adapter takes ~10s and doesn't proactively
            // cancel pending broadcasts. Polling fetchSockets is the only way
            // to detect "the target socket is gone" and abort fast (~2-4s).
            //
            // Requires 2 consecutive empty polls before declaring disconnect
            // to avoid false positives from transient Redis/adapter timeouts.
            const ackPromise = target.timeout(RPC_CALL_TIMEOUT_MS)
                .emitWithAck('rpc-request', { method, params });

            let presenceAlive = true;
            const presencePoll = (async () => {
                let consecutiveMisses = 0;
                while (presenceAlive) {
                    await sleep(RPC_PRESENCE_POLL_MS);
                    if (!presenceAlive) return;
                    const stillThere = await fetchRoomSockets(io, room, RPC_PRESENCE_FETCH_TIMEOUT_MS, 'presence');
                    if (!stillThere.some(s => s.id === target.id)) {
                        consecutiveMisses++;
                        if (consecutiveMisses >= 2) {
                            throw new Error('RPC target disconnected');
                        }
                    } else {
                        consecutiveMisses = 0;
                        if (!await ensureRpcTargetAuthorizationCurrent(userId, method, target)) {
                            throw new Error('RPC target disconnected');
                        }
                    }
                }
            })();

            try {
                const response = await Promise.race([ackPromise, presencePoll]);
                if (!await ensureRpcTargetAuthorizationCurrent(userId, method, target)) {
                    throw new Error('RPC target disconnected');
                }
                if (!isBoundedRpcResult(response)) {
                    finish('invalid_result');
                    callback?.({ ok: false, error: 'RPC response is invalid or too large' });
                    return;
                }
                finish('success');
                callback?.({ ok: true, result: response });
            } catch (error) {
                const targetDisconnected = error instanceof Error
                    && error.message === 'RPC target disconnected';
                finish(targetDisconnected ? 'target_disconnected' : 'request_failed');
                callback?.({
                    ok: false,
                    error: targetDisconnected ? 'RPC target disconnected' : 'RPC request failed',
                });
            } finally {
                presenceAlive = false;
            }
        } catch (error) {
            finish('internal_error');
            log({
                module: 'websocket',
                level: 'error',
                failureType: error instanceof Error ? 'error' : typeof error,
            }, 'RPC call failed');
            callback?.({ ok: false, error: 'Internal error' });
        } finally {
            releaseInFlight?.();
        }
    });

    socket.on('disconnect', () => {
        registrationLease.releaseAll();
    });

    // Socket.IO removes room membership automatically; this local handler only
    // releases the process-local account registration budget.
}
