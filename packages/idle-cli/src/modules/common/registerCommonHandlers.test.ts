import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const mocks = vi.hoisted(() => ({
    runRipgrep: vi.fn(),
    loggerDebug: vi.fn(),
    realpathHook: null as null | ((path: string) => Promise<boolean>),
    execFileHook: null as null | ((file: string, args: readonly string[]) => boolean),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        realpath: async (path: string) => {
            const result = await actual.realpath(path);
            if (mocks.realpathHook && await mocks.realpathHook(path)) {
                mocks.realpathHook = null;
            }
            return result;
        },
    };
});
vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const realExecFile = actual.execFile as (...args: unknown[]) => unknown;
    const wrappedExecFile = (...args: unknown[]) => {
        const [file, argv] = args;
        if (
            mocks.execFileHook
            && mocks.execFileHook(String(file), Array.isArray(argv) ? argv.map(String) : [])
        ) {
            mocks.execFileHook = null;
        }
        return realExecFile(...args);
    };
    Object.defineProperty(wrappedExecFile, Symbol.for('nodejs.util.promisify.custom'), {
        value: (...args: unknown[]) => new Promise((resolve, reject) => {
            wrappedExecFile(...args, (error: Error | null, stdout: unknown, stderr: unknown) => {
                if (error) reject(error);
                else resolve({ stdout, stderr });
            });
        }),
    });
    return {
        ...actual,
        execFile: wrappedExecFile,
    };
});
vi.mock('@/modules/ripgrep/index', () => ({ run: mocks.runRipgrep }));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.loggerDebug } }));

import { registerCommonHandlers } from './registerCommonHandlers';

const execFileAsync = promisify(execFile);
const GIT_FIXTURE_EMAIL = 'idle-security-fixture@users.noreply.github.com';

function createRpcHarness(workingDirectory: string) {
    const handlers = new Map<string, (request: any) => Promise<any>>();
    registerCommonHandlers({
        registerHandler: vi.fn((name: string, handler: (request: any) => Promise<any>) => {
            handlers.set(name, handler);
        }),
    } as any, workingDirectory);
    return handlers;
}

describe.skipIf(process.platform === 'win32')('common filesystem RPC containment', () => {
    let workspace: string;
    let outside: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.realpathHook = null;
        mocks.execFileHook = null;
        workspace = await mkdtemp(join(tmpdir(), 'idle-rpc-workspace-'));
        outside = await mkdtemp(join(tmpdir(), 'idle-rpc-outside-'));
        await writeFile(join(outside, 'secret.txt'), 'do-not-disclose');
        await symlink(join(outside, 'secret.txt'), join(workspace, 'linked-file'));
        await symlink(outside, join(workspace, 'linked-dir'));
        mocks.runRipgrep.mockResolvedValue({
            exitCode: 0,
            stdout: Buffer.from('inside.txt\n'),
            stderr: Buffer.alloc(0),
        });
    });

    afterEach(async () => {
        mocks.realpathHook = null;
        mocks.execFileHook = null;
        await Promise.all([
            rm(workspace, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true }),
        ]);
    });

    it('rejects symlink escapes for read and write operations', async () => {
        const handlers = createRpcHarness(workspace);

        await expect(handlers.get('readFile')!({ path: 'linked-file' })).resolves.toMatchObject({ success: false });
        await expect(handlers.get('writeFile')!({
            path: 'linked-file',
            content: Buffer.from('overwritten').toString('base64'),
            expectedHash: null,
        })).resolves.toMatchObject({ success: false });
        await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('do-not-disclose');
    });

    it('rejects a deterministic intermediate-directory swap after canonical validation', async () => {
        const handlers = createRpcHarness(workspace);
        const safeDirectory = join(workspace, 'safe');
        const movedSafeDirectory = join(workspace, 'safe-before-swap');
        await mkdir(safeDirectory);
        await writeFile(join(safeDirectory, 'secret.txt'), 'inside');

        mocks.realpathHook = async (path) => {
            if (!path.endsWith('/safe/secret.txt')) return false;
            await rename(safeDirectory, movedSafeDirectory);
            await symlink(outside, safeDirectory);
            return true;
        };

        const response = await handlers.get('readFile')!({ path: 'safe/secret.txt' });
        expect(response).toMatchObject({ success: false, error: expect.stringContaining('Access denied') });
        expect(response.content).toBeUndefined();
    });

    it('keeps the original trusted root when the workspace path itself is replaced', async () => {
        const projectDirectory = join(workspace, 'project');
        const movedProjectDirectory = join(workspace, 'project-before-swap');
        await mkdir(projectDirectory);
        await writeFile(join(projectDirectory, 'inside.txt'), 'inside');
        await writeFile(join(outside, 'inside.txt'), 'outside');
        const handlers = createRpcHarness(projectDirectory);

        mocks.realpathHook = async (path) => {
            if (!path.endsWith('/project/inside.txt')) return false;
            await rename(projectDirectory, movedProjectDirectory);
            await symlink(outside, projectDirectory);
            return true;
        };

        const response = await handlers.get('readFile')!({ path: 'inside.txt' });
        expect(response).toMatchObject({ success: false, error: expect.stringContaining('Access denied') });
        expect(response.content).toBeUndefined();
    });

    it('never creates a new file through a pathname that can be swapped after parent validation', async () => {
        const handlers = createRpcHarness(workspace);
        const safeDirectory = join(workspace, 'safe');
        const movedSafeDirectory = join(workspace, 'safe-before-swap');
        await mkdir(safeDirectory);

        mocks.realpathHook = async (path) => {
            if (!path.endsWith('/safe')) return false;
            await rename(safeDirectory, movedSafeDirectory);
            await symlink(outside, safeDirectory);
            return true;
        };

        await expect(handlers.get('writeFile')!({
            path: 'safe/created.txt',
            content: Buffer.from('created').toString('base64'),
            expectedHash: null,
        })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('new file'),
        });
        await expect(readFile(join(outside, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves normal existing-file read and hash-guarded edit functionality', async () => {
        const handlers = createRpcHarness(workspace);
        await writeFile(join(workspace, 'inside.txt'), 'inside');

        await expect(handlers.get('readFile')!({ path: 'inside.txt' })).resolves.toMatchObject({
            success: true,
            content: Buffer.from('inside').toString('base64'),
        });

        const updated = Buffer.from('updated');
        await expect(handlers.get('writeFile')!({
            path: 'inside.txt',
            content: updated.toString('base64'),
            expectedHash: createHash('sha256').update('inside').digest('hex'),
        })).resolves.toEqual({
            success: true,
            hash: createHash('sha256').update(updated).digest('hex'),
        });
        await expect(readFile(join(workspace, 'inside.txt'), 'utf8')).resolves.toBe('updated');

        await expect(handlers.get('writeFile')!({
            path: 'inside.txt',
            content: Buffer.from('should-not-write').toString('base64'),
            expectedHash: 'wrong-hash',
        })).resolves.toMatchObject({ success: false, error: expect.stringContaining('hash mismatch') });
        await expect(readFile(join(workspace, 'inside.txt'), 'utf8')).resolves.toBe('updated');

        const content = Buffer.from('created');
        await expect(handlers.get('writeFile')!({
            path: 'new-file.txt',
            content: content.toString('base64'),
            expectedHash: null,
        })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('new file'),
        });
        await expect(readFile(join(workspace, 'new-file.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('exposes only the typed file-listing ripgrep operation', async () => {
        const handlers = createRpcHarness(workspace);

        await expect(handlers.get('ripgrep')!({ args: ['--files', '/etc'] })).resolves.toMatchObject({ success: false });
        expect(mocks.runRipgrep).not.toHaveBeenCalled();

        await expect(handlers.get('ripgrep')!({ args: ['--files'] })).resolves.toMatchObject({
            success: true,
            stdout: 'inside.txt\n',
        });
        expect(mocks.runRipgrep).toHaveBeenCalledWith(['--files'], {
            maxOutputBytes: 1_048_576,
        });
    });

    it('rejects custom file-list directories before starting a pathname-based child', async () => {
        const handlers = createRpcHarness(workspace);
        await mkdir(join(workspace, 'nested'));

        await expect(handlers.get('ripgrep')!({
            args: ['--files'],
            cwd: 'nested',
        })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('workspace root'),
        });
        expect(mocks.runRipgrep).not.toHaveBeenCalled();
    });

    it('discards Git output when its opened workspace path changes before child spawn', async () => {
        const repository = join(workspace, 'repository');
        const movedRepository = join(workspace, 'repository-before-swap');
        await mkdir(repository);
        await writeFile(join(repository, 'inside.txt'), 'before\n');
        await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
        await execFileAsync('git', ['add', '--', 'inside.txt'], { cwd: repository });
        await execFileAsync('git', [
            '-c', 'commit.gpgSign=false',
            '-c', 'user.name=Idle Test',
            '-c', `user.email=${GIT_FIXTURE_EMAIL}`,
            'commit', '--quiet', '-m', 'fixture',
        ], { cwd: repository });
        await writeFile(join(repository, 'inside.txt'), 'after\n');

        mocks.execFileHook = (file, args) => {
            if (file !== 'git' || !args.includes('diff')) return false;
            renameSync(repository, movedRepository);
            symlinkSync(outside, repository, 'dir');
            return true;
        };

        const handlers = createRpcHarness(repository);
        await expect(handlers.get('gitDiff')!({ path: 'inside.txt', mode: 'working' })).resolves.toMatchObject({
            success: false,
            stdout: '',
            stderr: '',
            error: expect.stringContaining('Access denied'),
        });
    });

    it('enforces byte ceilings before returning file, diff, or file-list output', async () => {
        const handlers = createRpcHarness(workspace);
        await writeFile(join(workspace, 'large.txt'), 'x'.repeat(257));

        await expect(handlers.get('readFile')!({ path: 'large.txt', maxBytes: 256 })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('limit'),
        });
        await expect(handlers.get('readFile')!({ path: 'large.txt', maxBytes: 257 })).resolves.toMatchObject({
            success: true,
            content: Buffer.from('x'.repeat(257)).toString('base64'),
        });
        await expect(handlers.get('readFile')!({ path: 'large.txt', maxBytes: 8 * 1024 * 1024 })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('Invalid read request'),
        });

        await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
        await execFileAsync('git', ['add', '--', 'large.txt'], { cwd: workspace });
        await execFileAsync('git', [
            '-c', 'commit.gpgSign=false',
            '-c', 'user.name=Idle Test',
            '-c', `user.email=${GIT_FIXTURE_EMAIL}`,
            'commit', '--quiet', '-m', 'fixture',
        ], { cwd: workspace });
        await writeFile(join(workspace, 'large.txt'), 'y'.repeat(2_048));
        await expect(handlers.get('gitDiff')!({ path: 'large.txt', mode: 'working', maxBytes: 128 })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('limit'),
        });

        mocks.runRipgrep.mockResolvedValueOnce({
            exitCode: 0,
            stdout: '🙂'.repeat(65),
            stderr: '',
        });
        await expect(handlers.get('ripgrep')!({ args: ['--files'], maxBytes: 256 })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('limit'),
        });
    });

    it('does not register the unused raw difftastic RPC', () => {
        expect(createRpcHarness(workspace).has('difftastic')).toBe(false);
    });

    it('does not register the repo-unreachable list or recursive tree RPCs', () => {
        const handlers = createRpcHarness(workspace);
        expect(handlers.has('listDirectory')).toBe(false);
        expect(handlers.has('getDirectoryTree')).toBe(false);
    });

    it('never persists remote shell command text in diagnostics', async () => {
        const handlers = createRpcHarness(workspace);
        const sentinel = 'private-command-never-persist';

        await expect(handlers.get('bash')!({
            command: `printf ${sentinel}`,
            cwd: workspace,
            timeout: 1_000,
        })).resolves.toMatchObject({
            success: true,
            stdout: sentinel,
        });

        await expect(handlers.get('bash')!({
            command: `printf ${sentinel}; exit 1`,
            cwd: workspace,
            timeout: 1_000,
        })).resolves.toMatchObject({
            success: false,
            stdout: sentinel,
        });

        expect(JSON.stringify(mocks.loggerDebug.mock.calls)).not.toContain(sentinel);
    });

    it('never persists a remote file-list directory in diagnostics', async () => {
        const handlers = createRpcHarness(workspace);
        const sentinel = 'private-customer-workspace-never-persist';

        await expect(handlers.get('ripgrep')!({
            args: ['--files'],
            cwd: sentinel,
        })).resolves.toMatchObject({ success: false });

        expect(JSON.stringify(mocks.loggerDebug.mock.calls)).not.toContain(sentinel);
    });

    it('rejects malformed and oversized write requests before changing an existing file', async () => {
        const handlers = createRpcHarness(workspace);
        const filePath = join(workspace, 'inside.txt');
        await writeFile(filePath, 'inside');
        const expectedHash = createHash('sha256').update('inside').digest('hex');

        await expect(handlers.get('writeFile')!({
            path: 'inside.txt',
            content: 'not-valid-base64!?',
            expectedHash,
        })).resolves.toMatchObject({ success: false, error: expect.stringContaining('Invalid write request') });

        await expect(handlers.get('writeFile')!({
            path: 'inside.txt',
            content: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'),
            expectedHash,
        })).resolves.toMatchObject({ success: false, error: expect.stringContaining('Invalid write request') });

        await expect(readFile(filePath, 'utf8')).resolves.toBe('inside');

        const largeExistingPath = join(workspace, 'large-existing.bin');
        await writeFile(largeExistingPath, Buffer.alloc(4 * 1024 * 1024 + 1, 7));
        await expect(handlers.get('writeFile')!({
            path: 'large-existing.bin',
            content: Buffer.from('small').toString('base64'),
            expectedHash,
        })).resolves.toMatchObject({ success: false, error: expect.stringContaining('limit') });
        await expect(readFile(largeExistingPath)).resolves.toHaveLength(4 * 1024 * 1024 + 1);
    });

    it('treats git diff filenames as argv data instead of shell syntax', async () => {
        const handlers = createRpcHarness(workspace);
        const normalName = 'normal file.txt';
        const hostileName = 'quote"$(touch${IFS}idle-injection-marker).txt';
        const alternateHostileName = 'backtick`touch${IFS}idle-backtick-marker`.txt';
        const markerPath = join(workspace, 'idle-injection-marker');
        const alternateMarkerPath = join(workspace, 'idle-backtick-marker');

        await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
        await writeFile(join(workspace, normalName), 'before\n');
        await writeFile(join(workspace, hostileName), 'before\n');
        await writeFile(join(workspace, alternateHostileName), 'before\n');
        await execFileAsync('git', ['add', '--', normalName, hostileName, alternateHostileName], { cwd: workspace });
        await execFileAsync('git', [
            '-c', 'commit.gpgSign=false',
            '-c', 'user.name=Idle Test',
            '-c', `user.email=${GIT_FIXTURE_EMAIL}`,
            'commit', '--quiet', '-m', 'fixture',
        ], { cwd: workspace });
        await writeFile(join(workspace, normalName), 'after\n');
        await writeFile(join(workspace, hostileName), 'after\n');
        await writeFile(join(workspace, alternateHostileName), 'after\n');

        await expect(handlers.get('gitDiff')!({ path: normalName, mode: 'working' })).resolves.toMatchObject({
            success: true,
            stdout: expect.stringContaining('+after'),
        });
        await expect(handlers.get('gitDiff')!({ path: hostileName, mode: 'working' })).resolves.toMatchObject({
            success: true,
            stdout: expect.stringContaining('+after'),
        });
        await expect(handlers.get('gitDiff')!({ path: alternateHostileName, mode: 'head' })).resolves.toMatchObject({
            success: true,
            stdout: expect.stringContaining('+after'),
        });
        await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(alternateMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(handlers.get('gitDiff')!({ path: '../outside.txt', mode: 'working' })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('outside the working directory'),
        });
    });
});
