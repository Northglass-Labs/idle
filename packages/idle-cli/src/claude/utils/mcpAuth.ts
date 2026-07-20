import { randomBytes } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const IDLE_HTTP_MCP_TOKEN_FILE_ENV = 'IDLE_HTTP_MCP_TOKEN_FILE';

export interface McpCapabilityFile {
    authToken: string;
    cleanup: () => void;
    tokenFilePath: string;
}

export function createMcpCapabilityFile(idleHomeDir: string): McpCapabilityFile {
    const capabilityDirectory = join(idleHomeDir, 'tmp', 'mcp');
    mkdirSync(capabilityDirectory, { recursive: true, mode: 0o700 });

    const directoryStat = lstatSync(capabilityDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error('Idle MCP capability directory must be a real directory');
    }
    chmodSync(capabilityDirectory, 0o700);

    const authToken = randomBytes(32).toString('base64url');
    const tokenFilePath = join(
        capabilityDirectory,
        `session-${process.pid}-${randomBytes(8).toString('hex')}.token`,
    );
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(
        tokenFilePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
    );
    try {
        writeFileSync(descriptor, authToken, 'utf8');
    } finally {
        closeSync(descriptor);
    }
    chmodSync(tokenFilePath, 0o600);

    let cleanedUp = false;
    return {
        authToken,
        tokenFilePath,
        cleanup: () => {
            if (cleanedUp) return;
            cleanedUp = true;
            try {
                unlinkSync(tokenFilePath);
            } catch (error) {
                if (!isMissingFileError(error)) {
                    throw error;
                }
            }
        },
    };
}

export function readMcpCapabilityFile(tokenFilePath: string): string {
    if (!isAbsolute(tokenFilePath)) {
        throw new Error('Idle MCP capability path must be absolute');
    }

    const beforeOpen = lstatSync(tokenFilePath);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
        throw new Error('Idle MCP capability must be a regular file, not a symbolic link');
    }

    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(tokenFilePath, constants.O_RDONLY | noFollow);
    try {
        const afterOpen = fstatSync(descriptor);
        if (!afterOpen.isFile()) {
            throw new Error('Idle MCP capability must be a regular file');
        }
        if (beforeOpen.dev !== afterOpen.dev || beforeOpen.ino !== afterOpen.ino) {
            throw new Error('Idle MCP capability changed while it was being opened');
        }
        if (process.platform !== 'win32' && (afterOpen.mode & 0o077) !== 0) {
            throw new Error('Idle MCP capability has unsafe permissions');
        }

        const token = readFileSync(descriptor, 'utf8');
        if (!TOKEN_PATTERN.test(token)) {
            throw new Error('Idle MCP capability is malformed');
        }
        return token;
    } finally {
        closeSync(descriptor);
    }
}

function isMissingFileError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT',
    );
}
