import { z } from 'zod';

import type { ClientConnection } from '@/app/events/eventRouter';
import type { Socket } from 'socket.io';
import { canRegisterRpcMethod } from './rpcSecurity';
import {
    isRateLimitedSocketMutationEvent,
    SOCKET_MUTATION_RATE_LIMIT_ERROR,
    socketMutationRateLimiter,
} from './socketMutationRateLimit';

const ScopeIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const ScopeClaimSchema = z.discriminatedUnion('clientType', [
    z.object({
        clientType: z.literal('user-scoped'),
        sessionId: z.undefined().optional(),
        machineId: z.undefined().optional(),
    }).strict(),
    z.object({
        clientType: z.literal('session-scoped'),
        sessionId: ScopeIdSchema,
        machineId: z.undefined().optional(),
    }).strict(),
    z.object({
        clientType: z.literal('machine-scoped'),
        machineId: ScopeIdSchema,
        sessionId: z.undefined().optional(),
    }).strict(),
]);

export type AuthorizedSocketScope =
    | { clientType: 'user-scoped' }
    | { clientType: 'session-scoped'; sessionId: string; authorizationGeneration: number }
    | { clientType: 'machine-scoped'; machineId: string; authorizationGeneration: number };

interface ScopeOwnershipLookup {
    getSessionGeneration(accountId: string, sessionId: string): Promise<number | null>;
    getMachineGeneration(accountId: string, machineId: string): Promise<number | null>;
}

type ScopeAuthorizationResult =
    | { ok: true; scope: AuthorizedSocketScope }
    | { ok: false; error: string };

export async function authorizeSocketScope(
    accountId: string,
    claim: { clientType?: unknown; sessionId?: unknown; machineId?: unknown },
    lookup: ScopeOwnershipLookup,
): Promise<ScopeAuthorizationResult> {
    const normalizedClaim = claim.clientType === undefined
        ? { ...claim, clientType: 'user-scoped' }
        : claim;
    const parsed = ScopeClaimSchema.safeParse(normalizedClaim);
    if (!parsed.success) {
        if (
            normalizedClaim.clientType === 'user-scoped'
            && (normalizedClaim.sessionId !== undefined || normalizedClaim.machineId !== undefined)
        ) {
            return { ok: false, error: 'User-scoped clients cannot claim a session or machine' };
        }
        return { ok: false, error: 'Invalid socket scope' };
    }

    if (parsed.data.clientType === 'user-scoped') {
        return { ok: true, scope: { clientType: 'user-scoped' } };
    }
    if (parsed.data.clientType === 'session-scoped') {
        const authorizationGeneration = await lookup.getSessionGeneration(accountId, parsed.data.sessionId);
        return authorizationGeneration !== null
            ? { ok: true, scope: { ...parsed.data, authorizationGeneration } }
            : { ok: false, error: 'Session scope is not authorized' };
    }
    const authorizationGeneration = await lookup.getMachineGeneration(accountId, parsed.data.machineId);
    return authorizationGeneration !== null
        ? { ok: true, scope: { ...parsed.data, authorizationGeneration } }
        : { ok: false, error: 'Machine scope is not authorized' };
}

export const SOCKET_EVENT_AUTHORIZATION_ERROR = 'Socket event is not authorized';

export type ActiveSocketClientEvent =
    | 'app-state'
    | 'machine-alive'
    | 'machine-update-metadata'
    | 'machine-update-state'
    | 'message'
    | 'ping'
    | 'rpc-call'
    | 'rpc-register'
    | 'rpc-unregister'
    | 'session-alive'
    | 'session-end'
    | 'update-metadata'
    | 'update-state'
    | 'usage-report';

const SESSION_TARGET_FIELDS = new Map<string, 'sid' | 'sessionId'>([
    ['message', 'sid'],
    ['session-alive', 'sid'],
    ['session-end', 'sid'],
    ['update-metadata', 'sid'],
    ['update-state', 'sid'],
    ['usage-report', 'sessionId'],
]);

const MACHINE_ONLY_EVENTS = new Set([
    'machine-alive',
    'machine-update-state',
]);

const USER_ONLY_EVENTS = new Set([
    'app-state',
    'rpc-call',
]);

const RETIRED_SOCKET_EVENTS = new Set([
    'access-key-get',
    'artifact-create',
    'artifact-delete',
    'artifact-read',
    'artifact-update',
]);

function readTargetId(data: unknown, field: 'sid' | 'sessionId' | 'machineId'): string | null {
    if (!data || typeof data !== 'object') return null;
    const value = (data as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Authorize one application-level Socket.IO event against the immutable scope
 * established during the authenticated handshake. This is deliberately
 * deny-by-default: adding a server handler also requires an explicit policy
 * decision here.
 */
export function isSocketEventAuthorized(
    connection: ClientConnection,
    event: string,
    data: unknown,
): boolean {
    if (RETIRED_SOCKET_EVENTS.has(event)) return false;
    if (event === 'ping') return true;
    if (USER_ONLY_EVENTS.has(event)) return connection.connectionType === 'user-scoped';

    if (event === 'rpc-register' || event === 'rpc-unregister') {
        if (!data || typeof data !== 'object') return false;
        const method = (data as Record<string, unknown>).method;
        return typeof method === 'string' && canRegisterRpcMethod(connection, method);
    }

    const sessionTargetField = SESSION_TARGET_FIELDS.get(event);
    if (sessionTargetField) {
        return connection.connectionType === 'session-scoped'
            && readTargetId(data, sessionTargetField) === connection.sessionId;
    }

    if (MACHINE_ONLY_EVENTS.has(event)) {
        return connection.connectionType === 'machine-scoped'
            && readTargetId(data, 'machineId') === connection.machineId;
    }

    if (event === 'machine-update-metadata') {
        if (connection.connectionType === 'user-scoped') return true;
        return connection.connectionType === 'machine-scoped'
            && readTargetId(data, 'machineId') === connection.machineId;
    }

    return false;
}

type SocketEventHandler = (...args: any[]) => unknown;

function rejectSocketEvent(
    socket: Socket,
    event: string,
    args: any[],
    error = SOCKET_EVENT_AUTHORIZATION_ERROR,
): void {
    if (event === 'rpc-register' || event === 'rpc-unregister') {
        socket.emit('rpc-error', {
            type: event === 'rpc-register' ? 'register' : 'unregister',
            error,
        });
        return;
    }

    const acknowledgement = args.at(-1);
    if (typeof acknowledgement !== 'function') return;

    if (event === 'usage-report') {
        acknowledgement({ success: false, error });
        return;
    }
    if (event === 'rpc-call' || event === 'access-key-get') {
        acknowledgement({ ok: false, error });
        return;
    }
    acknowledgement({ result: 'error', message: error });
}

/** Register a client event behind the central capability check. */
export function onAuthorizedSocketEvent(
    socket: Socket,
    connection: ClientConnection,
    event: ActiveSocketClientEvent,
    handler: SocketEventHandler,
): void {
    socket.on(event, async (...args: any[]) => {
        if (!isSocketEventAuthorized(connection, event, args[0])) {
            rejectSocketEvent(socket, event, args);
            return;
        }
        let isCurrent = false;
        try {
            isCurrent = await connection.isAuthorizationCurrent();
        } catch {
            // Authorization storage uncertainty must fail closed.
        }
        if (!isCurrent) {
            rejectSocketEvent(socket, event, args);
            socket.disconnect(true);
            return;
        }
        // A revocation sweep may win immediately after the durable lookup. Do
        // not enter a handler on a transport revoked while the lookup ran.
        if (socket.connected === false) return;
        if (
            isRateLimitedSocketMutationEvent(event)
            && !socketMutationRateLimiter.allow(connection.userId)
        ) {
            rejectSocketEvent(socket, event, args, SOCKET_MUTATION_RATE_LIMIT_ERROR);
            return;
        }
        const result = await handler(...args);
        let remainsCurrent = false;
        try {
            remainsCurrent = await connection.isAuthorizationCurrent();
        } catch {
            // Authorization storage uncertainty must fail closed.
        }
        if (!remainsCurrent) socket.disconnect(true);
        return result;
    });
}
