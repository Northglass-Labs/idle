import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const testState = vi.hoisted(() => {
    const root = `/tmp/idle-api-session-log-privacy-${process.pid}`;
    return {
        root,
        logsDir: `${root}/logs`,
        homeDir: `${root}/home`,
        handlers: new Map<string, Array<(...args: any[]) => void>>(),
        emitWithAck: vi.fn(),
        socket: {
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: (...args: any[]) => void) => {
                const handlers = testState.handlers.get(event) ?? [];
                handlers.push(handler);
                testState.handlers.set(event, handlers);
            }),
            off: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            volatile: { emit: vi.fn() },
            close: vi.fn(),
        },
        io: vi.fn(),
    };
});

vi.mock('node:os', async () => ({
    ...(await vi.importActual<typeof import('node:os')>('node:os')),
    homedir: () => testState.homeDir,
}));

vi.mock('socket.io-client', () => ({ io: testState.io }));
vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
    },
}));
vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test',
        idleHomeDir: testState.root,
        logsDir: testState.logsDir,
        isDaemonProcess: false,
    },
}));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    },
}));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/utils/lidState', () => ({ shouldReconnect: () => false }));

import { ApiSessionClient } from './apiSession';
import { encodeBase64, encrypt } from './encryption';

async function waitFor(check: () => void): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            check();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
}

describe('ApiSessionClient real logger privacy boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mkdirSync(testState.root, { recursive: true, mode: 0o700 });
        testState.handlers.clear();
        testState.socket.emitWithAck = testState.emitWithAck;
        testState.io.mockReturnValue(testState.socket);
    });

    afterAll(() => {
        rmSync(testState.root, { recursive: true, force: true });
    });

    it('does not persist opaque provider arguments or raw socket error text', async () => {
        const opaqueArgument = 'OPAQUE_REAL_LOG_ARGUMENT_25ec';
        const opaqueReason = 'OPAQUE_REAL_LOG_REASON_9fd0';
        const opaqueSocketError = 'OPAQUE_REAL_LOG_SOCKET_ERROR_c01a';
        const encryptionKey = new Uint8Array(32);
        const updatedState = {
            requests: {},
            completedRequests: {
                'opaque-provider-id': {
                    tool: 'shell',
                    arguments: { command: opaqueArgument },
                    createdAt: 1,
                    completedAt: 2,
                    status: 'denied' as const,
                    reason: opaqueReason,
                },
            },
        };
        testState.emitWithAck.mockImplementationOnce(async (_event: string, data: any) => ({
            result: 'success',
            version: 1,
            agentState: data.agentState,
        }));
        const client = new ApiSessionClient('fake-token', {
            id: 'test-session',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: testState.homeDir,
                idleHomeDir: testState.root,
                idleLibDir: `${testState.root}/lib`,
                idleToolsDir: `${testState.root}/tools`,
            },
            metadataVersion: 0,
            agentState: {
                requests: {
                    'opaque-provider-id': {
                        tool: 'shell',
                        arguments: { command: opaqueArgument },
                        createdAt: 1,
                    },
                },
            },
            agentStateVersion: 0,
            encryptionKey,
            encryptionVariant: 'legacy',
        });

        client.updateAgentState(() => updatedState);
        for (const handler of testState.handlers.get('error') ?? []) {
            handler(new Error(opaqueSocketError));
        }

        await waitFor(() => {
            expect(testState.emitWithAck).toHaveBeenCalled();
            expect((client as any).agentStateVersion).toBe(1);
        });
        const logOutput = readdirSync(testState.logsDir)
            .filter((file) => file.endsWith('.log'))
            .map((file) => readFileSync(join(testState.logsDir, file), 'utf8'))
            .join('\n');

        expect(logOutput).toContain('Agent state updated');
        expect(logOutput).toContain('errorType');
        expect(logOutput).not.toContain(opaqueArgument);
        expect(logOutput).not.toContain(opaqueReason);
        expect(logOutput).not.toContain(opaqueSocketError);
        expect(logOutput).not.toContain('opaque-provider-id');
        await client.close();
    });
});
