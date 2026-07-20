import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { validateExistingPath, validatePath } from './pathSecurity';

describe('validatePath', () => {
    const workingDir = resolve('/home/user/project');

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve('/home/user/project/file.txt'), workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/src/file.txt'),
        });
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath(resolve('/etc/passwd'), workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
        expect(validatePath(workingDir, workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
    });
});

describe.skipIf(process.platform === 'win32')('secure workspace path validation', () => {
    let workspace: string;
    let outside: string;

    beforeEach(async () => {
        workspace = await mkdtemp(join(tmpdir(), 'idle-path-workspace-'));
        outside = await mkdtemp(join(tmpdir(), 'idle-path-outside-'));
        await mkdir(join(workspace, 'src'));
        await writeFile(join(workspace, 'src', 'inside.txt'), 'inside');
        await writeFile(join(outside, 'secret.txt'), 'outside');
    });

    afterEach(async () => {
        await Promise.all([
            rm(workspace, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true }),
        ]);
    });

    it('accepts existing files under real workspace directories', async () => {
        const canonicalWorkspace = await realpath(workspace);
        await expect(validateExistingPath('src/inside.txt', workspace)).resolves.toMatchObject({
            valid: true,
            resolvedPath: join(canonicalWorkspace, 'src', 'inside.txt'),
        });
    });

    it('rejects final and intermediate symlinks even when their names are inside the workspace', async () => {
        await symlink(join(outside, 'secret.txt'), join(workspace, 'linked-file'));
        await symlink(outside, join(workspace, 'linked-dir'));

        await expect(validateExistingPath('linked-file', workspace)).resolves.toMatchObject({ valid: false });
        await expect(validateExistingPath('linked-dir/secret.txt', workspace)).resolves.toMatchObject({ valid: false });
    });
});
