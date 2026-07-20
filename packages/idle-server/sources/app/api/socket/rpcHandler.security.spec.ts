import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, generationState, logSpy } = vi.hoisted(() => {
    const generationState = {
        session: 1_000 as number | null,
        machine: 2_000 as number | null,
        account: 7 as number | null,
        accountSuspended: false,
    };
    return {
        generationState,
        logSpy: vi.fn(),
        dbMock: {
            account: {
                findUnique: vi.fn(async () => generationState.account === null
                    ? null
                    : {
                        authVersion: generationState.account,
                        authSuspendedAt: generationState.accountSuspended ? new Date() : null,
                    }),
            },
            session: {
                findFirst: vi.fn(async () => generationState.session === null
                    ? null
                    : { createdAt: new Date(generationState.session) }),
            },
            machine: {
                findFirst: vi.fn(async () => generationState.machine === null
                    ? null
                    : { createdAt: new Date(generationState.machine) }),
            },
        },
    };
});

vi.mock('../../../utils/log', () => ({ log: logSpy }));
vi.mock('../../../storage/db', () => ({ db: dbMock }));

import { rpcHandler } from './rpcHandler';

type EventHandler = (...args: any[]) => unknown;

function createSocketHarness(id: string) {
    const handlers = new Map<string, EventHandler[]>();
    const emitted: Array<{ event: string; data: unknown }> = [];
    const joined: string[] = [];
    const left: string[] = [];
    const socket = {
        id,
        on: vi.fn((event: string, handler: EventHandler) => {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        }),
        emit: vi.fn((event: string, data: unknown) => {
            emitted.push({ event, data });
        }),
        join: vi.fn((room: string) => joined.push(room)),
        leave: vi.fn((room: string) => left.push(room)),
        disconnect: vi.fn(),
    };

    return {
        socket,
        emitted,
        joined,
        left,
        async trigger(event: string, ...args: unknown[]) {
            await Promise.all((handlers.get(event) ?? []).map((handler) => handler(...args)));
        },
    };
}

function userConnection(socket: any) {
    return {
        connectionType: 'user-scoped' as const,
        userId: 'account-1',
        accountAuthorizationGeneration: 7,
        isAuthorizationCurrent: vi.fn(async () => true),
        socket,
    };
}

function remoteSessionTarget(
    emitWithAck: ReturnType<typeof vi.fn>,
    authorizationGeneration = 1_000,
) {
    return {
        id: 'target-socket',
        data: {
            userId: 'account-1',
            clientType: 'session-scoped',
            sessionId: 'session-1',
            authorizationGeneration,
            accountAuthorizationGeneration: 7,
            rpcRegistrationAuthorized: true,
        },
        disconnect: vi.fn(),
        timeout: vi.fn(() => ({ emitWithAck })),
    };
}

function remoteMachineTarget(
    emitWithAck: ReturnType<typeof vi.fn>,
    authorizationGeneration = 2_000,
) {
    return {
        id: 'machine-target-socket',
        data: {
            userId: 'account-1',
            clientType: 'machine-scoped',
            machineId: 'machine-1',
            authorizationGeneration,
            accountAuthorizationGeneration: 7,
            rpcRegistrationAuthorized: true,
        },
        disconnect: vi.fn(),
        timeout: vi.fn(() => ({ emitWithAck })),
    };
}

describe('rpcHandler registration boundary', () => {
    beforeEach(() => {
        generationState.session = 1_000;
        generationState.machine = 2_000;
        generationState.account = 7;
        generationState.accountSuspended = false;
        vi.clearAllMocks();
    });

    it('joins only methods bound to the authenticated session socket', async () => {
        const harness = createSocketHarness('socket-1');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            {
                connectionType: 'session-scoped',
                userId: 'account-1',
                sessionId: 'session-1',
                authorizationGeneration: 1_000,
                isAuthorizationCurrent: vi.fn(async () => true),
                rpcRegistrationAuthorized: true,
                socket: harness.socket as any,
            },
        );

        await harness.trigger('rpc-register', { method: 'session-2:bash' });
        expect(harness.joined).toEqual([]);
        expect(harness.emitted).toContainEqual({
            event: 'rpc-error',
            data: { type: 'register', error: 'Socket event is not authorized' },
        });

        await harness.trigger('rpc-register', { method: 'session-1:bash' });
        expect(harness.joined).toEqual(['rpc:account-1:session-1:bash']);
        await harness.trigger('disconnect');
    });

    it('rejects an owned session registration made with an ordinary bearer', async () => {
        const harness = createSocketHarness('ordinary-bearer-socket');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            {
                connectionType: 'session-scoped',
                userId: 'account-1',
                sessionId: 'session-1',
                authorizationGeneration: 1_000,
                isAuthorizationCurrent: vi.fn(async () => true),
                rpcRegistrationAuthorized: false,
                socket: harness.socket as any,
            },
        );

        await harness.trigger('rpc-register', { method: 'session-1:bash' });

        expect(harness.joined).toEqual([]);
        expect(harness.emitted).toContainEqual({
            event: 'rpc-error',
            data: { type: 'register', error: 'Socket event is not authorized' },
        });
        await harness.trigger('disconnect');
    });

    it('disconnects a deleted session generation before accepting a new RPC registration', async () => {
        const harness = createSocketHarness('stale-session-socket');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            {
                connectionType: 'session-scoped',
                userId: 'account-1',
                sessionId: 'session-1',
                authorizationGeneration: 1_000,
                isAuthorizationCurrent: vi.fn(async () => false),
                rpcRegistrationAuthorized: true,
                socket: harness.socket as any,
            },
        );

        await harness.trigger('rpc-register', { method: 'session-1:bash' });

        expect(harness.joined).toEqual([]);
        expect(harness.socket.disconnect).toHaveBeenCalledWith(true);
        expect(harness.emitted).toContainEqual({
            event: 'rpc-error',
            data: { type: 'register', error: 'Socket event is not authorized' },
        });
        await harness.trigger('disconnect');
    });

    it('does not allow a user-scoped caller socket to register', async () => {
        const harness = createSocketHarness('socket-2');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            userConnection(harness.socket),
        );

        await harness.trigger('rpc-register', { method: 'session-1:bash' });
        expect(harness.joined).toEqual([]);
        await harness.trigger('disconnect');
    });

    it('will not unregister a method the socket did not register', async () => {
        const harness = createSocketHarness('socket-3');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            {
                connectionType: 'machine-scoped',
                userId: 'account-1',
                machineId: 'machine-1',
                authorizationGeneration: 2_000,
                isAuthorizationCurrent: vi.fn(async () => true),
                rpcRegistrationAuthorized: true,
                socket: harness.socket as any,
            },
        );

        await harness.trigger('rpc-unregister', { method: 'machine-1:stop-daemon' });
        expect(harness.left).toEqual([]);
        expect(harness.emitted).toContainEqual({
            event: 'rpc-error',
            data: { type: 'unregister', error: 'RPC method is not registered by this socket' },
        });
        await harness.trigger('disconnect');
    });

    it('allows only user-scoped caller sockets to originate RPC work', async () => {
        const harness = createSocketHarness('socket-4');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            {
                connectionType: 'session-scoped',
                userId: 'account-1',
                sessionId: 'session-1',
                authorizationGeneration: 1_000,
                isAuthorizationCurrent: vi.fn(async () => true),
                socket: harness.socket as any,
            },
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'machine-1:stop-daemon',
            params: 'ciphertext',
        }, callback);
        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'Socket event is not authorized',
        }));
        await harness.trigger('disconnect');
    });

    it('fails closed when more than one socket claims the same RPC target', async () => {
        const harness = createSocketHarness('caller-socket');
        const firstEmitWithAck = vi.fn(async () => 'first-result');
        const secondEmitWithAck = vi.fn(async () => 'second-result');
        const targets = [
            { id: 'target-1', timeout: vi.fn(() => ({ emitWithAck: firstEmitWithAck })) },
            { id: 'target-2', timeout: vi.fn(() => ({ emitWithAck: secondEmitWithAck })) },
        ];
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => targets),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'RPC method not available',
        }));
        expect(firstEmitWithAck).not.toHaveBeenCalled();
        expect(secondEmitWithAck).not.toHaveBeenCalled();
        await harness.trigger('disconnect');
    });

    it('preserves a bounded user-scoped call to the registered target', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => 'encrypted-result');
        const target = remoteSessionTarget(emitWithAck);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [target]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: 'encrypted-result',
        }));
        expect(emitWithAck).toHaveBeenCalledWith('rpc-request', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        });
        await harness.trigger('disconnect');
    });

    it('rejects and disconnects a target whose session generation was deleted or replaced', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => 'must-not-run');
        const target = remoteSessionTarget(emitWithAck, 1_000);
        generationState.session = 3_000;
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [target]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC method not available' });
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(target.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects and disconnects a target whose machine generation was deleted or replaced', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => 'must-not-run');
        const target = remoteMachineTarget(emitWithAck, 2_000);
        generationState.machine = null;
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [target]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'machine-1:bash',
            params: 'encrypted-params',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC method not available' });
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(target.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects and disconnects a target whose account generation was suspended or replaced', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => 'must-not-run');
        const target = remoteSessionTarget(emitWithAck);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({ fetchSockets: vi.fn(async () => [target]) })),
            })),
        };
        generationState.account = 8;
        rpcHandler('account-1', harness.socket as any, io as any, userConnection(harness.socket));
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC method not available' });
        expect(emitWithAck).not.toHaveBeenCalled();
        expect(target.disconnect).toHaveBeenCalledWith(true);
        await harness.trigger('disconnect');
    });

    it('evicts a stale generation before resolving ambiguity with its valid replacement', async () => {
        const harness = createSocketHarness('caller-socket');
        const staleEmitWithAck = vi.fn(async () => 'stale-result');
        const currentEmitWithAck = vi.fn(async () => 'current-result');
        const staleTarget = remoteSessionTarget(staleEmitWithAck, 3_000);
        staleTarget.id = 'stale-target-socket';
        const currentTarget = remoteSessionTarget(currentEmitWithAck, 1_000);
        currentTarget.id = 'current-target-socket';
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [staleTarget, currentTarget]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: true, result: 'current-result' });
        expect(staleTarget.disconnect).toHaveBeenCalledWith(true);
        expect(staleEmitWithAck).not.toHaveBeenCalled();
        expect(currentEmitWithAck).toHaveBeenCalledOnce();
    });

    it('does not return an RPC result whose target was revoked while the call was in flight', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => {
            generationState.session = null;
            return 'stale-result';
        });
        const target = remoteSessionTarget(emitWithAck);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [target]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC target disconnected' });
        expect(callback).not.toHaveBeenCalledWith({ ok: true, result: 'stale-result' });
        expect(target.disconnect).toHaveBeenCalledWith(true);
    });

    it('does not return target or adapter exception prose to the caller', async () => {
        const harness = createSocketHarness('caller-socket');
        const emitWithAck = vi.fn(async () => {
            throw new Error('credential-like adapter detail');
        });
        const target = remoteSessionTarget(emitWithAck);
        const io = {
            in: vi.fn(() => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => [target]),
                })),
            })),
        };
        rpcHandler(
            'account-1',
            harness.socket as any,
            io as any,
            userConnection(harness.socket),
        );
        const callback = vi.fn();

        await harness.trigger('rpc-call', {
            method: 'session-1:bash',
            params: 'encrypted-params',
        }, callback);

        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'RPC request failed',
        }));
        expect(JSON.stringify(callback.mock.calls)).not.toContain('credential-like adapter detail');
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain('credential-like adapter detail');
        await harness.trigger('disconnect');
    });

    it('keeps unexpected rpc-call diagnostics value-free', async () => {
        const harness = createSocketHarness('caller-socket');
        rpcHandler(
            'account-1',
            harness.socket as any,
            {} as any,
            userConnection(harness.socket),
        );
        let firstCallback = true;
        const callback = vi.fn(() => {
            if (firstCallback) {
                firstCallback = false;
                throw new Error('private callback exception prose');
            }
        });

        await harness.trigger('rpc-call', {}, callback);

        await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: 'Internal error',
        }));
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({ module: 'websocket', level: 'error' }),
            'RPC call failed',
        );
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private callback exception prose');
        await harness.trigger('disconnect');
    });
});
