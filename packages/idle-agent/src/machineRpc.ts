import { io, Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import {
    AuthenticatedRpcResponseSchema,
    createAuthenticatedRpcRequest,
    type AuthenticatedRpcRequestIdentity,
} from '@northglass/idle-wire';
import type { Config } from './config';
import type { DecryptedMachine } from './api';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';

export type SupportedAgent = 'claude' | 'codex' | 'gemini' | 'openclaw';

export type SpawnMachineSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export type StopMachineSessionResult = { message: 'Session stopped' };

const MAX_CONTROL_RPC_CIPHERTEXT_CHARACTERS = 64 * 1024;
const MAX_SESSION_ID_CHARACTERS = 64;
const MAX_DIRECTORY_CHARACTERS = 16 * 1024;
const MAX_MACHINE_HOME_CHARACTERS = 4 * 1024;
const MAX_CONTROL_ERROR_CHARACTERS = 2 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeTerminalText(value: unknown, maxCharacters: number): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxCharacters
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCanonicalControlCiphertext(value: unknown): value is string {
    if (
        typeof value !== 'string'
        || value.length < 4
        || value.length > MAX_CONTROL_RPC_CIPHERTEXT_CHARACTERS
        || value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        return false;
    }

    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 && decoded.toString('base64') === value;
}

function waitForConnect(socket: Socket, timeoutMs = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (socket.connected) {
            resolve();
            return;
        }

        const timeout = setTimeout(() => {
            socket.off('connect', onConnect);
            socket.off('connect_error', onError);
            reject(new Error('Timeout waiting for socket connection'));
        }, timeoutMs);

        const onConnect = () => {
            clearTimeout(timeout);
            socket.off('connect_error', onError);
            resolve();
        };

        const onError = (error: Error) => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            reject(error);
        };

        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
    });
}

function normalizeRpcError(error: string | undefined, machineId: string): string {
    if (error === 'RPC method not available') {
        return `Machine ${machineId} is offline or its daemon is not connected.`;
    }
    // All other acknowledgement errors come from the relay transport rather
    // than authenticated machine ciphertext. Do not reflect their contents
    // into the local terminal.
    return 'RPC call failed';
}

function decryptRpcResult(
    response: unknown,
    machine: DecryptedMachine,
    expected: AuthenticatedRpcRequestIdentity,
): unknown {
    if (!isRecord(response) || typeof response.ok !== 'boolean') {
        throw new Error('RPC call returned an invalid acknowledgement');
    }
    if (!response.ok) {
        throw new Error(normalizeRpcError(
            typeof response.error === 'string' ? response.error : undefined,
            machine.id,
        ));
    }
    if (!isCanonicalControlCiphertext(response.result)) {
        throw new Error('RPC call returned invalid encrypted result');
    }

    const decrypted = decrypt(
        machine.encryption.key,
        machine.encryption.variant,
        decodeBase64(response.result),
    );
    const parsed = AuthenticatedRpcResponseSchema.safeParse(decrypted);
    if (
        !parsed.success
        || parsed.data.scope !== expected.scope
        || parsed.data.method !== expected.method
        || parsed.data.requestId !== expected.requestId
    ) {
        throw new Error('RPC call returned invalid data');
    }
    if (!parsed.data.ok) {
        throw new Error('Remote control request was rejected');
    }
    return parsed.data.result;
}

function parseSpawnResult(value: unknown): SpawnMachineSessionResult {
    if (!isRecord(value)) {
        throw new Error('RPC call returned unexpected data');
    }

    if (
        value.type === 'success'
        && isSafeTerminalText(value.sessionId, MAX_SESSION_ID_CHARACTERS)
        && /^[A-Za-z0-9_-]+$/.test(value.sessionId)
    ) {
        return { type: 'success', sessionId: value.sessionId };
    }
    if (
        value.type === 'requestToApproveDirectoryCreation'
        && isSafeTerminalText(value.directory, MAX_DIRECTORY_CHARACTERS)
    ) {
        return { type: 'requestToApproveDirectoryCreation', directory: value.directory };
    }
    if (
        value.type === 'error'
        && isSafeTerminalText(value.errorMessage, MAX_CONTROL_ERROR_CHARACTERS)
    ) {
        return { type: 'error', errorMessage: value.errorMessage };
    }
    throw new Error('RPC call returned unexpected data');
}

function throwAuthenticatedMachineError(value: unknown): void {
    if (isRecord(value) && isSafeTerminalText(value.error, MAX_CONTROL_ERROR_CHARACTERS)) {
        throw new Error(value.error);
    }
}

function encryptRpcRequest(
    machine: DecryptedMachine,
    method: string,
    params: unknown,
): { params: string; expected: AuthenticatedRpcRequestIdentity } {
    const request = createAuthenticatedRpcRequest(
        machine.id,
        method,
        params,
        randomUUID(),
        Date.now(),
    );
    return {
        params: encodeBase64(encrypt(
            machine.encryption.key,
            machine.encryption.variant,
            request,
        )),
        expected: {
            scope: request.scope,
            method: request.method,
            requestId: request.requestId,
        },
    };
}

async function callAuthenticatedMachineRpc(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    method: string,
    params: unknown,
): Promise<unknown> {
    const socket = io(config.serverUrl, {
        auth: {
            token,
        },
        path: '/v1/updates',
        transports: ['websocket'],
        autoConnect: false,
        reconnection: false,
    });

    socket.connect();

    try {
        await waitForConnect(socket);
        const rpc = encryptRpcRequest(machine, method, params);
        const response: unknown = await socket.timeout(30_000).emitWithAck('rpc-call', {
            method: `${machine.id}:${method}`,
            params: rpc.params,
        });
        return decryptRpcResult(response, machine, rpc.expected);
    } finally {
        socket.close();
    }
}

function isRemoteAbsolutePath(value: string): boolean {
    return posix.isAbsolute(value) || win32.isAbsolute(value);
}

export async function getMachineHomeDirectory(
    config: Config,
    machine: DecryptedMachine,
    token: string,
): Promise<string> {
    const result = await callAuthenticatedMachineRpc(
        config,
        machine,
        token,
        'machine-home-directory',
        {},
    );
    if (
        !isRecord(result)
        || !isSafeTerminalText(result.directory, MAX_MACHINE_HOME_CHARACTERS)
        || !isRemoteAbsolutePath(result.directory)
    ) {
        throw new Error('RPC call returned unexpected data');
    }
    return result.directory;
}

export async function spawnSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    options: {
        directory: string;
        approvedNewDirectoryCreation?: boolean;
        agent?: SupportedAgent;
    },
): Promise<SpawnMachineSessionResult> {
    const decrypted = await callAuthenticatedMachineRpc(
        config,
        machine,
        token,
        'spawn-idle-session',
        {
            type: 'spawn-in-directory',
            directory: options.directory,
            approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? false,
            agent: options.agent,
        },
    );
    throwAuthenticatedMachineError(decrypted);
    return parseSpawnResult(decrypted);
}

export async function resumeSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    sessionId: string,
): Promise<SpawnMachineSessionResult> {
    const decrypted = await callAuthenticatedMachineRpc(
        config,
        machine,
        token,
        'resume-idle-session',
        { sessionId },
    );
    throwAuthenticatedMachineError(decrypted);
    return parseSpawnResult(decrypted);
}

export async function stopSessionOnMachine(
    config: Config,
    machine: DecryptedMachine,
    token: string,
    sessionId: string,
): Promise<StopMachineSessionResult> {
    const decrypted = await callAuthenticatedMachineRpc(
        config,
        machine,
        token,
        'stop-session',
        { sessionId },
    );
    throwAuthenticatedMachineError(decrypted);

    if (
        !isRecord(decrypted)
        ||
        decrypted.message !== 'Session stopped'
    ) {
        throw new Error('RPC call returned unexpected data');
    }

    return { message: 'Session stopped' };
}
