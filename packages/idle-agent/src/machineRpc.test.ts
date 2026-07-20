import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import type { DecryptedMachine } from './api';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from './encryption';
import {
    AuthenticatedRpcRequestSchema,
    createAuthenticatedRpcSuccess,
} from '@northglass/idle-wire';
import {
    getMachineHomeDirectory,
    resumeSessionOnMachine,
    spawnSessionOnMachine,
    stopSessionOnMachine,
} from './machineRpc';

const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

const config: Config = {
    serverUrl: 'https://test-server.example.com',
    homeDir: '/tmp/idle-agent-test',
    credentialPath: '/tmp/idle-agent-test/agent.key',
};

function makeMachine(): DecryptedMachine {
    return {
        id: 'machine-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {},
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        encryption: {
            key: getRandomBytes(32),
            variant: 'dataKey',
        },
    };
}

function boundRpcResult(
    machine: DecryptedMachine,
    requestCiphertext: string,
    result: unknown,
): string {
    const request = AuthenticatedRpcRequestSchema.parse(decrypt(
        machine.encryption.key,
        machine.encryption.variant,
        decodeBase64(requestCiphertext),
    ));
    return encodeBase64(encrypt(
        machine.encryption.key,
        machine.encryption.variant,
        createAuthenticatedRpcSuccess(request, result),
    ));
}

describe('authenticated machine RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses the encrypted machine-scoped stop RPC and waits for its acknowledgement', async () => {
        const machine = makeMachine();
        const emitWithAck = vi.fn(async (_event: string, request: { method: string; params: string }) => {
            expect(request.method).toBe('machine-1:stop-session');
            expect(decrypt(
                machine.encryption.key,
                machine.encryption.variant,
                decodeBase64(request.params),
            )).toEqual(expect.objectContaining({
                kind: 'idle-rpc-request',
                v: 2,
                scope: 'machine-1',
                method: 'stop-session',
                requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                issuedAt: expect.any(Number),
                params: { sessionId: 'session-1' },
            }));

            return {
                ok: true,
                result: boundRpcResult(machine, request.params, { message: 'Session stopped' }),
            };
        });
        const close = vi.fn();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close,
            timeout: vi.fn(() => ({ emitWithAck })),
        });

        await expect(stopSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .resolves.toEqual({ message: 'Session stopped' });

        expect(mockIo).toHaveBeenCalledWith(config.serverUrl, expect.objectContaining({
            auth: { token: 'account-token' },
            path: '/v1/updates',
            transports: ['websocket'],
            autoConnect: false,
            reconnection: false,
        }));
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.any(Object));
        expect(close).toHaveBeenCalledOnce();
    });

    it.each(['spawn-idle-session', 'resume-idle-session'] as const)(
        'sends %s inside an authenticated machine RPC envelope',
        async (expectedMethod) => {
            const machine = makeMachine();
            const expectedParams = expectedMethod === 'spawn-idle-session'
                ? {
                    type: 'spawn-in-directory',
                    directory: '/workspace',
                    approvedNewDirectoryCreation: true,
                    agent: 'codex',
                }
                : { sessionId: 'session-1' };
            const emitWithAck = vi.fn(async (_event: string, request: { method: string; params: string }) => {
                expect(request.method).toBe(`machine-1:${expectedMethod}`);
                const plaintext = decrypt(
                    machine.encryption.key,
                    machine.encryption.variant,
                    decodeBase64(request.params),
                );
                expect(plaintext).toEqual(expect.objectContaining({
                    kind: 'idle-rpc-request',
                    v: 2,
                    scope: 'machine-1',
                    method: expectedMethod,
                    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                    issuedAt: expect.any(Number),
                    params: expectedParams,
                }));
                return {
                    ok: true,
                    result: boundRpcResult(
                        machine,
                        request.params,
                        { type: 'success', sessionId: 'new-session' },
                    ),
                };
            });
            mockIo.mockReturnValue({
                connected: true,
                connect: vi.fn(),
                close: vi.fn(),
                timeout: vi.fn(() => ({ emitWithAck })),
            });

            const invoke = expectedMethod === 'spawn-idle-session'
                ? () => spawnSessionOnMachine(config, machine, 'account-token', {
                    directory: '/workspace',
                    approvedNewDirectoryCreation: true,
                    agent: 'codex',
                })
                : () => resumeSessionOnMachine(config, machine, 'account-token', 'session-1');

            await expect(invoke()).resolves.toEqual({ type: 'success', sessionId: 'new-session' });
        },
    );

    it('reports an unavailable daemon as a stop failure', async () => {
        const machine = makeMachine();
        const close = vi.fn();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close,
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({
                    ok: false,
                    error: 'RPC method not available',
                })),
            })),
        });

        await expect(stopSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .rejects.toThrow('Machine machine-1 is offline or its daemon is not connected.');
        expect(close).toHaveBeenCalledOnce();
    });

    it('does not repeat an untrusted relay RPC error in terminal output', async () => {
        const machine = makeMachine();
        const marker = 'sensitive-relay-rpc-marker';
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async () => ({ ok: false, error: marker })),
            })),
        });

        let failure: unknown;
        try {
            await stopSessionOnMachine(config, machine, 'account-token', 'session-1');
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('RPC call failed');
        expect((failure as Error).message).not.toContain(marker);
    });

    it('rejects malformed or oversized encrypted control results before returning them', async () => {
        const machine = makeMachine();
        let call = 0;
        const emitWithAck = vi.fn(async (_event: string, request: { params: string }) => ({
            ok: true,
            result: call++ === 0
                ? boundRpcResult(machine, request.params, { type: 'success' })
                : 'A'.repeat(64 * 1024 + 1),
        }));
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({ emitWithAck })),
        });

        await expect(resumeSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .rejects.toThrow('RPC call returned unexpected data');
        await expect(resumeSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .rejects.toThrow('RPC call returned invalid encrypted result');
    });

    it('rejects a null authenticated stop result as unexpected data', async () => {
        const machine = makeMachine();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async (_event: string, request: { params: string }) => ({
                    ok: true,
                    result: boundRpcResult(machine, request.params, null),
                })),
            })),
        });

        await expect(stopSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .rejects.toThrow('RPC call returned unexpected data');
    });

    it('reports the daemon containment error instead of claiming success', async () => {
        const machine = makeMachine();
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({
                emitWithAck: vi.fn(async (_event: string, request: { params: string }) => ({
                    ok: true,
                    result: boundRpcResult(machine, request.params,
                        { error: 'Session not found or failed to stop' },
                    ),
                })),
            })),
        });

        await expect(stopSessionOnMachine(config, machine, 'account-token', 'session-1'))
            .rejects.toThrow('Session not found or failed to stop');
    });

    it('rejects a captured spawn result when it is replayed for a fresh request', async () => {
        const machine = makeMachine();
        let capturedResponse: string | undefined;
        let call = 0;
        const emitWithAck = vi.fn(async (_event: string, request: { params: string }) => {
            call += 1;
            if (call === 1) {
                capturedResponse = boundRpcResult(
                    machine,
                    request.params,
                    { type: 'success', sessionId: 'first-session' },
                );
            }
            return { ok: true, result: capturedResponse };
        });
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({ emitWithAck })),
        });

        await expect(spawnSessionOnMachine(config, machine, 'account-token', {
            directory: '/workspace',
        })).resolves.toMatchObject({ sessionId: 'first-session' });
        await expect(spawnSessionOnMachine(config, machine, 'account-token', {
            directory: '/workspace',
        })).rejects.toThrow('RPC call returned invalid data');
    });

    it('gets the home directory from a fresh authenticated daemon RPC', async () => {
        const machine = makeMachine();
        const emitWithAck = vi.fn(async (_event: string, request: { method: string; params: string }) => {
            expect(request.method).toBe('machine-1:machine-home-directory');
            expect(decrypt(
                machine.encryption.key,
                machine.encryption.variant,
                decodeBase64(request.params),
            )).toEqual(expect.objectContaining({
                kind: 'idle-rpc-request',
                scope: 'machine-1',
                method: 'machine-home-directory',
                params: {},
            }));
            return {
                ok: true,
                result: boundRpcResult(machine, request.params, { directory: '/live-machine-home' }),
            };
        });
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({ emitWithAck })),
        });

        await expect(getMachineHomeDirectory(config, machine, 'account-token'))
            .resolves.toBe('/live-machine-home');
    });

    it('rejects a captured home-directory result when replayed for a fresh request', async () => {
        const machine = makeMachine();
        let capturedResponse: string | undefined;
        const emitWithAck = vi.fn(async (_event: string, request: { params: string }) => {
            capturedResponse ??= boundRpcResult(
                machine,
                request.params,
                { directory: '/captured-home' },
            );
            return { ok: true, result: capturedResponse };
        });
        mockIo.mockReturnValue({
            connected: true,
            connect: vi.fn(),
            close: vi.fn(),
            timeout: vi.fn(() => ({ emitWithAck })),
        });

        await expect(getMachineHomeDirectory(config, machine, 'account-token'))
            .resolves.toBe('/captured-home');
        await expect(getMachineHomeDirectory(config, machine, 'account-token'))
            .rejects.toThrow('RPC call returned invalid data');
    });
});
