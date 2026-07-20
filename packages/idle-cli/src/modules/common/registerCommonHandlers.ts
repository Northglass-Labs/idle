import { logger } from '@/ui/logger';
import { exec, execFile, ExecFileOptions, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { constants } from 'node:fs';
import { createHash } from 'crypto';
import { relative, resolve, sep } from 'path';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import { openExistingWorkspacePath, type OpenedWorkspacePath, validateExistingPath, validatePath } from './pathSecurity';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

interface GitDiffRequest {
    path: string;
    mode: 'working' | 'head';
    timeout?: number;
    maxBytes?: number;
}

interface GitDiffResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

interface ReadFileRequest {
    path: string;
    maxBytes?: number;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
    maxBytes?: number;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_FILE_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FILE_LIST_RESPONSE_BYTES = 1 * 1024 * 1024;
const MAX_RPC_PATH_LENGTH = 16_384;
const MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = Math.floor(MAX_RPC_RESPONSE_BYTES / 4) * 3;

function resolveResponseLimit(requested: number | undefined, fallback: number): number | null {
    const value = requested ?? fallback;
    return Number.isInteger(value) && value >= 1 && value <= MAX_RPC_RESPONSE_BYTES
        ? value
        : null;
}

function resolveFileResponseLimit(requested: number | undefined): number | null {
    const value = requested ?? DEFAULT_FILE_RESPONSE_BYTES;
    return Number.isInteger(value) && value >= 1 && value <= MAX_FILE_RESPONSE_BYTES
        ? value
        : null;
}

function isValidRpcPath(path: unknown): path is string {
    return typeof path === 'string'
        && path.length > 0
        && path.length <= MAX_RPC_PATH_LENGTH
        && !path.includes('\0');
}

function decodeBoundedBase64(content: unknown): Buffer | null {
    if (typeof content !== 'string' || content.length > Math.ceil(MAX_FILE_WRITE_BYTES / 3) * 4) {
        return null;
    }
    if (content.length === 0) return Buffer.alloc(0);
    if (content.length % 4 !== 0) {
        return null;
    }

    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    if ((content.length / 4) * 3 - padding > MAX_FILE_WRITE_BYTES) return null;

    const buffer = Buffer.from(content, 'base64');
    return buffer.length <= MAX_FILE_WRITE_BYTES && buffer.toString('base64') === content
        ? buffer
        : null;
}

async function readWorkspaceFile(targetPath: string, workingDirectory: string, maxBytes: number): Promise<Buffer> {
    const opened = await openExistingWorkspacePath(
        targetPath,
        workingDirectory,
        constants.O_RDONLY,
        'file',
    );
    try {
        const buffer = await readBoundedFileHandle(opened.handle, maxBytes);
        await opened.assertStillSafe();
        return buffer;
    } finally {
        await opened.handle.close();
    }
}

async function readBoundedFileHandle(
    handle: OpenedWorkspacePath['handle'],
    maxBytes: number,
): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > maxBytes) {
        throw new Error(`File exceeds ${maxBytes}-byte limit`);
    }
    return buffer.subarray(0, offset);
}

/**
 * Register all RPC handlers with the session
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {

    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request received', {
            commandBytes: Buffer.byteLength(data.command, 'utf8'),
            hasCustomCwd: Boolean(data.cwd && data.cwd !== '/'),
        });

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        if (data.cwd && data.cwd !== '/') {
            const validation = await validateExistingPath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
            const options: ExecOptions = {
                cwd: data.cwd === '/' ? undefined : data.cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
                windowsHide: true, // Prevent cmd.exe popup on Windows for every RPC bash call
            };

            logger.debug('Shell command executing', {
                hasCustomCwd: options.cwd !== undefined,
                timeout: options.timeout,
            });
            const { stdout, stderr } = await execAsync(data.command, options);
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
            };
            logger.debug('Shell command result:', {
                success: true,
                exitCode: 0,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
            };

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
                };
                logger.debug('Shell command timed out:', {
                    success: false,
                    exitCode: result.exitCode,
                    error: 'Command timed out'
                });
                return result;
            }

            // If exec fails, it includes stdout/stderr in the error
            const result = {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed'
            };
            logger.debug('Shell command failed:', {
                success: false,
                exitCode: result.exitCode,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        }
    });

    // Typed Git diff handler. Repository filenames are passed as argv data so
    // quotes, command substitutions, and platform-specific metacharacters can
    // never be interpreted by a shell before Git sees the pathspec.
    rpcHandlerManager.registerHandler<GitDiffRequest, GitDiffResponse>('gitDiff', async (data) => {
        const maxBytes = resolveResponseLimit(data?.maxBytes, DEFAULT_FILE_RESPONSE_BYTES);
        if (
            !data
            || maxBytes === null
            || typeof data.path !== 'string'
            || data.path.length === 0
            || data.path.length > 16_384
            || data.path.includes('\0')
            || (data.mode !== 'working' && data.mode !== 'head')
        ) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: -1,
                error: 'Invalid Git diff request',
            };
        }

        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid || !validation.resolvedPath) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: -1,
                error: validation.error || 'Invalid Git diff path',
            };
        }

        const relativePath = relative(resolve(workingDirectory), validation.resolvedPath);
        if (!relativePath || relativePath === '.') {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: -1,
                error: 'Invalid Git diff path',
            };
        }
        const gitPath = sep === '\\' ? relativePath.split(sep).join('/') : relativePath;
        const args = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv'];
        if (data.mode === 'head') {
            args.push('HEAD');
        }
        args.push('--', gitPath);

        const requestedTimeout = typeof data.timeout === 'number' && Number.isFinite(data.timeout)
            ? Math.trunc(data.timeout)
            : 30_000;
        let openedWorkspace: OpenedWorkspacePath;
        try {
            openedWorkspace = await openExistingWorkspacePath(
                '.',
                workingDirectory,
                constants.O_RDONLY,
                'directory',
            );
        } catch (error) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: -1,
                error: error instanceof Error ? error.message : 'Invalid Git workspace',
            };
        }

        const options: ExecFileOptions = {
            cwd: openedWorkspace.resolvedPath,
            timeout: Math.min(120_000, Math.max(1, requestedTimeout)),
            maxBuffer: maxBytes,
            windowsHide: true,
        };

        try {
            try {
                const { stdout, stderr } = await execFileAsync('git', args, options);
                const stdoutText = stdout ? stdout.toString() : '';
                const stderrText = stderr ? stderr.toString() : '';
                if (Buffer.byteLength(stdoutText) + Buffer.byteLength(stderrText) > maxBytes) {
                    return {
                        success: false,
                        stdout: '',
                        stderr: '',
                        exitCode: -1,
                        error: `Git diff exceeds ${maxBytes}-byte response limit`,
                    };
                }
                await openedWorkspace.assertStillSafe();
                return {
                    success: true,
                    stdout: stdoutText,
                    stderr: stderrText,
                    exitCode: 0,
                };
            } catch (error) {
                const execError = error as NodeJS.ErrnoException & {
                    stdout?: string | Buffer;
                    stderr?: string | Buffer;
                    code?: number | string;
                    killed?: boolean;
                };
                const timedOut = execError.code === 'ETIMEDOUT' || execError.killed;
                const outputExceeded = execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                    || execError.message?.includes('maxBuffer');
                try {
                    await openedWorkspace.assertStillSafe();
                } catch (pathError) {
                    return {
                        success: false,
                        stdout: '',
                        stderr: '',
                        exitCode: -1,
                        error: pathError instanceof Error ? pathError.message : 'Git workspace changed during execution',
                    };
                }
                return {
                    success: false,
                    stdout: outputExceeded ? '' : (execError.stdout ? execError.stdout.toString() : ''),
                    stderr: outputExceeded ? '' : (execError.stderr ? execError.stderr.toString() : ''),
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: outputExceeded
                        ? `Git diff exceeds ${maxBytes}-byte response limit`
                        : timedOut ? 'Git diff timed out' : (execError.message || 'Git diff failed'),
                };
            }
        } finally {
            await openedWorkspace.handle.close();
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request received');

        const maxBytes = resolveFileResponseLimit(data?.maxBytes);
        if (!data || maxBytes === null || !isValidRpcPath(data.path)) {
            return { success: false, error: 'Invalid read request' };
        }

        try {
            const buffer = await readWorkspaceFile(data.path, workingDirectory, maxBytes);
            const content = buffer.toString('base64');
            return { success: true, content };
        } catch (error) {
            logger.debug('Failed to read file');
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request received');

        if (!data || !isValidRpcPath(data.path)) {
            return { success: false, error: 'Invalid write request' };
        }

        // Node exposes O_NOFOLLOW for the final component, but not openat2's
        // RESOLVE_BENEATH/NO_SYMLINKS semantics for a new child. Creating by
        // pathname would therefore leave an unavoidable parent-swap window.
        // Idle's file editor only saves files it has already read, so fail
        // closed for unsupported new-file creation.
        if (data.expectedHash === null || data.expectedHash === undefined) {
            return { success: false, error: 'Secure new file creation is not supported' };
        }
        if (typeof data.expectedHash !== 'string' || data.expectedHash.length === 0 || data.expectedHash.length > 256) {
            return { success: false, error: 'Invalid write request' };
        }

        const buffer = decodeBoundedBase64(data.content);
        if (!buffer) {
            return { success: false, error: 'Invalid write request' };
        }

        try {
            const opened = await openExistingWorkspacePath(
                data.path,
                workingDirectory,
                constants.O_RDWR,
                'file',
            );
            try {
                const existingBuffer = await readBoundedFileHandle(opened.handle, MAX_FILE_WRITE_BYTES);
                const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
                if (existingHash !== data.expectedHash) {
                    return {
                        success: false,
                        error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                    };
                }

                // Recheck immediately before destructive I/O. The write then
                // stays bound to this descriptor even if the pathname moves.
                await opened.assertStillSafe();
                await opened.handle.truncate(0);
                if (buffer.length > 0) {
                    await opened.handle.write(buffer, 0, buffer.length, 0);
                }
                await opened.handle.sync();
            } finally {
                await opened.handle.close();
            }

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file');
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // Ripgrep handler - deliberately limited to workspace file discovery.
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        const maxBytes = resolveResponseLimit(data?.maxBytes, DEFAULT_FILE_LIST_RESPONSE_BYTES);

        if (
            !data
            || maxBytes === null
            || !Array.isArray(data.args)
            || data.args.length !== 1
            || data.args[0] !== '--files'
        ) {
            return { success: false, error: 'Only workspace file listing is supported' };
        }
        if (data.cwd !== undefined) {
            return { success: false, error: 'File listing is restricted to the workspace root' };
        }
        logger.debug('Workspace file-list request received', {
            maxBytes,
        });

        try {
            // No caller-controlled pathname crosses the child-process boundary.
            // The launcher inherits this CLI process's already-open cwd.
            const result = await runRipgrep(['--files'], {
                maxOutputBytes: maxBytes,
            });
            if (
                Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxBytes
                || result.stderr.toString().toLowerCase().includes('output exceeded limit')
            ) {
                return { success: false, error: `File listing exceeds ${maxBytes}-byte response limit` };
            }
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep');
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

}
