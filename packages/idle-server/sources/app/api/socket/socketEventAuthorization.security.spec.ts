import { readFileSync, readdirSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConnection } from '../../events/eventRouter';
import {
    isSocketEventAuthorized,
    onAuthorizedSocketEvent,
    SOCKET_EVENT_AUTHORIZATION_ERROR,
} from './socketScope';
import {
    MAX_SOCKET_MUTATIONS_PER_MINUTE,
    SOCKET_MUTATION_RATE_LIMIT_ERROR,
    socketMutationRateLimiter,
} from './socketMutationRateLimit';

function connection(
    connectionType: 'user-scoped' | 'session-scoped' | 'machine-scoped',
    id?: string,
    rpcRegistrationAuthorized = true,
    isAuthorizationCurrent = vi.fn(async () => true),
): ClientConnection {
    const socket = {} as any;
    if (connectionType === 'session-scoped') {
        return {
            connectionType,
            userId: 'account-1',
            sessionId: id!,
            authorizationGeneration: 1_000,
            accountAuthorizationGeneration: 7,
            isAuthorizationCurrent,
            rpcRegistrationAuthorized,
            socket,
        };
    }
    if (connectionType === 'machine-scoped') {
        return {
            connectionType,
            userId: 'account-1',
            machineId: id!,
            authorizationGeneration: 1_000,
            accountAuthorizationGeneration: 7,
            isAuthorizationCurrent,
            rpcRegistrationAuthorized,
            socket,
        };
    }
    return {
        connectionType,
        userId: 'account-1',
        accountAuthorizationGeneration: 7,
        isAuthorizationCurrent,
        socket,
    };
}

const user = connection('user-scoped');
const sessionOne = connection('session-scoped', 'session-1');
const sessionTwo = connection('session-scoped', 'session-2');
const machineOne = connection('machine-scoped', 'machine-1');
const machineTwo = connection('machine-scoped', 'machine-2');

describe('Socket.IO event capability authorization', () => {
    beforeEach(() => {
        socketMutationRateLimiter.clear();
    });

    it.each([
        ['update-metadata', { sid: 'session-1' }],
        ['update-state', { sid: 'session-1' }],
        ['session-alive', { sid: 'session-1' }],
        ['message', { sid: 'session-1' }],
        ['session-end', { sid: 'session-1' }],
        ['usage-report', { sessionId: 'session-1' }],
    ] as const)('binds %s to the exact authenticated session', (event, data) => {
        expect(isSocketEventAuthorized(sessionOne, event, data)).toBe(true);
        expect(isSocketEventAuthorized(sessionTwo, event, data)).toBe(false);
        expect(isSocketEventAuthorized(machineOne, event, data)).toBe(false);
        expect(isSocketEventAuthorized(user, event, data)).toBe(false);
    });

    it.each([
        ['machine-alive', { machineId: 'machine-1' }],
        ['machine-update-state', { machineId: 'machine-1' }],
    ] as const)('binds %s to the exact authenticated machine', (event, data) => {
        expect(isSocketEventAuthorized(machineOne, event, data)).toBe(true);
        expect(isSocketEventAuthorized(machineTwo, event, data)).toBe(false);
        expect(isSocketEventAuthorized(sessionOne, event, data)).toBe(false);
        expect(isSocketEventAuthorized(user, event, data)).toBe(false);
    });

    it('allows account-wide machine metadata changes only from the app or the exact machine', () => {
        const event = 'machine-update-metadata';
        const data = { machineId: 'machine-1' };

        expect(isSocketEventAuthorized(user, event, data)).toBe(true);
        expect(isSocketEventAuthorized(machineOne, event, data)).toBe(true);
        expect(isSocketEventAuthorized(machineTwo, event, data)).toBe(false);
        expect(isSocketEventAuthorized(sessionOne, event, data)).toBe(false);
    });

    it.each(['app-state', 'rpc-call'] as const)(
        'allows the explicitly account-wide %s event only from a user socket',
        (event) => {
            expect(isSocketEventAuthorized(user, event, {})).toBe(true);
            expect(isSocketEventAuthorized(sessionOne, event, {})).toBe(false);
            expect(isSocketEventAuthorized(machineOne, event, {})).toBe(false);
        },
    );

    it('preserves exact session and machine RPC registration without sibling authority', () => {
        expect(isSocketEventAuthorized(sessionOne, 'rpc-register', { method: 'session-1:bash' })).toBe(true);
        expect(isSocketEventAuthorized(sessionOne, 'rpc-unregister', { method: 'session-1:bash' })).toBe(true);
        expect(isSocketEventAuthorized(sessionOne, 'rpc-register', { method: 'session-2:bash' })).toBe(false);
        expect(isSocketEventAuthorized(machineOne, 'rpc-register', { method: 'machine-1:stop-daemon' })).toBe(true);
        expect(isSocketEventAuthorized(machineOne, 'rpc-register', { method: 'machine-2:stop-daemon' })).toBe(false);
        expect(isSocketEventAuthorized(user, 'rpc-register', { method: 'session-1:bash' })).toBe(false);
        expect(isSocketEventAuthorized(
            connection('session-scoped', 'session-1', false),
            'rpc-register',
            { method: 'session-1:bash' },
        )).toBe(false);
    });

    it.each([
        'artifact-read',
        'artifact-update',
        'artifact-create',
        'artifact-delete',
        'access-key-get',
    ] as const)('retires the unused legacy %s socket event for every credential scope', (event) => {
        expect(isSocketEventAuthorized(user, event, {})).toBe(false);
        expect(isSocketEventAuthorized(sessionOne, event, {})).toBe(false);
        expect(isSocketEventAuthorized(machineOne, event, {})).toBe(false);
    });

    it('allows targetless liveness pings but denies malformed and unknown events', () => {
        expect(isSocketEventAuthorized(user, 'ping', undefined)).toBe(true);
        expect(isSocketEventAuthorized(sessionOne, 'ping', undefined)).toBe(true);
        expect(isSocketEventAuthorized(machineOne, 'ping', undefined)).toBe(true);

        expect(isSocketEventAuthorized(sessionOne, 'message', null)).toBe(false);
        expect(isSocketEventAuthorized(sessionOne, 'message', { sid: 1 })).toBe(false);
        expect(isSocketEventAuthorized(machineOne, 'machine-alive', { machineId: '' })).toBe(false);
        expect(isSocketEventAuthorized(user, 'not-a-real-event', {})).toBe(false);
    });

    it('drops a sibling event before its handler and returns a generic acknowledgement', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
        } as any;
        const handler = vi.fn();
        const callback = vi.fn();

        onAuthorizedSocketEvent(socket, sessionOne, 'update-metadata', handler);
        await registered?.({ sid: 'session-2', metadata: 'ciphertext', expectedVersion: 0 }, callback);

        expect(handler).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            result: 'error',
            message: SOCKET_EVENT_AUTHORIZATION_ERROR,
        });
        expect(JSON.stringify(callback.mock.calls)).not.toContain('session-1');
        expect(JSON.stringify(callback.mock.calls)).not.toContain('session-2');
    });

    it('returns the same generic RPC error without echoing either scope ID', () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
        } as any;
        const handler = vi.fn();

        onAuthorizedSocketEvent(socket, sessionOne, 'rpc-register', handler);
        registered?.({ method: 'session-2:bash' });

        expect(handler).not.toHaveBeenCalled();
        expect(socket.emit).toHaveBeenCalledWith('rpc-error', {
            type: 'register',
            error: SOCKET_EVENT_AUTHORIZATION_ERROR,
        });
        expect(JSON.stringify(socket.emit.mock.calls)).not.toContain('session-1');
        expect(JSON.stringify(socket.emit.mock.calls)).not.toContain('session-2');
    });

    it('lets the exact capability reach the existing handler unchanged', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
        } as any;
        const handler = vi.fn(async () => 'handled');
        const callback = vi.fn();
        const data = { sid: 'session-1', metadata: 'ciphertext', expectedVersion: 0 };

        onAuthorizedSocketEvent(socket, sessionOne, 'update-metadata', handler);
        await expect(registered?.(data, callback)).resolves.toBe('handled');

        expect(handler).toHaveBeenCalledWith(data, callback);
        expect(callback).not.toHaveBeenCalled();
    });

    it('disconnects a deleted or replaced object capability before its handler runs', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
            disconnect: vi.fn(),
        } as any;
        const handler = vi.fn();
        const callback = vi.fn();
        const staleSession = connection(
            'session-scoped',
            'session-1',
            true,
            vi.fn(async () => false),
        );

        onAuthorizedSocketEvent(socket, staleSession, 'update-metadata', handler);
        await registered?.(
            { sid: 'session-1', metadata: 'ciphertext', expectedVersion: 0 },
            callback,
        );

        expect(handler).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            result: 'error',
            message: SOCKET_EVENT_AUTHORIZATION_ERROR,
        });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects a suspended user-scoped capability before an RPC handler runs', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
            disconnect: vi.fn(),
        } as any;
        const handler = vi.fn();
        const callback = vi.fn();
        const staleUser = connection(
            'user-scoped',
            undefined,
            true,
            vi.fn(async () => false),
        );

        onAuthorizedSocketEvent(socket, staleUser, 'rpc-call', handler);
        await registered?.({ method: 'session-1:bash', params: 'ciphertext' }, callback);

        expect(handler).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: SOCKET_EVENT_AUTHORIZATION_ERROR,
        });
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('revokes a capability deleted while its handler is in flight', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            connected: true,
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
            disconnect: vi.fn(),
        } as any;
        const isAuthorizationCurrent = vi.fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const handler = vi.fn(async () => 'handled-before-revocation-completed');
        const scopedConnection = connection(
            'session-scoped',
            'session-1',
            true,
            isAuthorizationCurrent,
        );

        onAuthorizedSocketEvent(socket, scopedConnection, 'update-metadata', handler);
        await registered?.({ sid: 'session-1', metadata: 'ciphertext', expectedVersion: 0 });

        expect(handler).toHaveBeenCalledOnce();
        expect(isAuthorizationCurrent).toHaveBeenCalledTimes(2);
        expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('does not enter a handler after the room sweep disconnects its socket during revalidation', async () => {
        let registered: ((...args: any[]) => unknown) | undefined;
        const socket = {
            connected: true,
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                registered = handler;
            }),
            emit: vi.fn(),
            disconnect: vi.fn(),
        } as any;
        const isAuthorizationCurrent = vi.fn(async () => {
            socket.connected = false;
            return true;
        });
        const handler = vi.fn();
        const scopedConnection = connection(
            'machine-scoped',
            'machine-1',
            true,
            isAuthorizationCurrent,
        );

        onAuthorizedSocketEvent(socket, scopedConnection, 'machine-alive', handler);
        await registered?.({ machineId: 'machine-1' });

        expect(handler).not.toHaveBeenCalled();
    });

    it('shares one mutation budget across every socket for an account', async () => {
        let firstRegistered: ((...args: any[]) => unknown) | undefined;
        let secondRegistered: ((...args: any[]) => unknown) | undefined;
        const firstSocket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                firstRegistered = handler;
            }),
        } as any;
        const secondSocket = {
            on: vi.fn((_event: string, handler: (...args: any[]) => unknown) => {
                secondRegistered = handler;
            }),
        } as any;
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();
        const callback = vi.fn();
        const payload = { sid: 'session-1', metadata: 'ciphertext', expectedVersion: 0 };

        onAuthorizedSocketEvent(firstSocket, { ...sessionOne, socket: firstSocket }, 'update-metadata', firstHandler);
        onAuthorizedSocketEvent(secondSocket, { ...sessionOne, socket: secondSocket }, 'update-metadata', secondHandler);
        for (let index = 0; index < MAX_SOCKET_MUTATIONS_PER_MINUTE; index += 1) {
            await firstRegistered?.(payload);
        }
        await secondRegistered?.(payload, callback);

        expect(firstHandler).toHaveBeenCalledTimes(MAX_SOCKET_MUTATIONS_PER_MINUTE);
        expect(secondHandler).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            result: 'error',
            message: SOCKET_MUTATION_RATE_LIMIT_ERROR,
        });
        expect(JSON.stringify(callback.mock.calls)).not.toContain('account-1');
        expect(JSON.stringify(callback.mock.calls)).not.toContain('session-1');
    });

    it('requires every production client event registration to use the central guard', () => {
        const productionTypescriptBelow = (directory: URL): URL[] => readdirSync(directory, { withFileTypes: true })
            .flatMap((entry) => {
                const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
                if (entry.isDirectory()) return productionTypescriptBelow(child);
                if (!entry.name.endsWith('.ts') || /\.(?:spec|test)\./.test(entry.name)) return [];
                return [child];
            });
        const files = productionTypescriptBelow(new URL('../', import.meta.url));
        const directRegistrations = files.flatMap((file) => {
            const source = readFileSync(file, 'utf8');
            return [...source.matchAll(/\bsocket\.(on|once|addListener|prependListener)\(\s*([^,\n]+)/g)]
                .map((match) => ({
                    file: file.pathname,
                    method: match[1],
                    argument: match[2].trim(),
                }))
                .filter(({ file, method, argument }) => !(
                    argument === "'disconnect'"
                    || argument === '"disconnect"'
                    || (file.endsWith('/socketScope.ts') && method === 'on' && argument === 'event')
                ));
        });

        expect(directRegistrations).toEqual([]);
    });
});
