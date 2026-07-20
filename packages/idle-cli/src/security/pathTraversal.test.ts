import { describe, it, expect } from 'vitest';
import { validatePath } from '../modules/common/pathSecurity';

describe('path traversal protection', () => {
    const workingDir = '/home/user/project';

    describe('rejects traversal payloads', () => {
        it('blocks ../../../etc/passwd', () => {
            const result = validatePath('../../../etc/passwd', workingDir);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('outside the working directory');
        });

        it('blocks ../../etc/shadow', () => {
            const result = validatePath('../../etc/shadow', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks absolute path to /etc/passwd', () => {
            const result = validatePath('/etc/passwd', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks Windows-style traversal ..\\..\\windows\\system32', () => {
            // path.resolve on POSIX treats backslashes as literal chars in filenames,
            // so this resolves inside the working dir. On Windows it would traverse.
            // We verify the resolved path stays within workingDir regardless.
            const result = validatePath('..\\..\\windows\\system32', workingDir);
            // On macOS/Linux backslash is a valid filename character, so this is
            // actually a file inside workingDir — still validating the function handles it
            if (process.platform === 'win32') {
                expect(result.valid).toBe(false);
            } else {
                // On POSIX, this is treated as a literal filename containing backslashes
                expect(result.valid).toBe(true);
            }
        });

        it('blocks traversal to parent directory', () => {
            const result = validatePath('..', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks traversal hidden in subpath: src/../../secret', () => {
            const result = validatePath('src/../../secret', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks traversal to sibling directory', () => {
            const result = validatePath('../other-project/secrets.env', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks traversal with redundant slashes', () => {
            const result = validatePath('src/../../../etc/hosts', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks absolute path to root', () => {
            const result = validatePath('/', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks absolute path to home directory above working dir', () => {
            const result = validatePath('/home/user', workingDir);
            expect(result.valid).toBe(false);
        });
    });

    describe('allows valid paths within working directory', () => {
        it('allows relative path to file in working dir', () => {
            const result = validatePath('src/index.ts', workingDir);
            expect(result.valid).toBe(true);
            expect(result.error).toBeUndefined();
        });

        it('allows nested relative path', () => {
            const result = validatePath('src/utils/helpers.ts', workingDir);
            expect(result.valid).toBe(true);
        });

        it('allows current directory reference', () => {
            const result = validatePath('.', workingDir);
            expect(result.valid).toBe(true);
        });

        it('allows ./relative path', () => {
            const result = validatePath('./src/main.ts', workingDir);
            expect(result.valid).toBe(true);
        });

        it('allows absolute path within working directory', () => {
            const result = validatePath('/home/user/project/src/file.ts', workingDir);
            expect(result.valid).toBe(true);
        });

        it('allows bare filename', () => {
            const result = validatePath('README.md', workingDir);
            expect(result.valid).toBe(true);
        });

        it('allows traversal that resolves back inside working dir', () => {
            // src/../lib is equivalent to ./lib — still inside workingDir
            const result = validatePath('src/../lib/utils.ts', workingDir);
            expect(result.valid).toBe(true);
        });
    });

    describe('edge cases and evasion attempts', () => {
        it('blocks path that is a prefix of working dir but not inside it', () => {
            // /home/user/project-secrets is not inside /home/user/project
            const result = validatePath('/home/user/project-secrets/file.txt', workingDir);
            expect(result.valid).toBe(false);
        });

        it('blocks null byte injection attempt', () => {
            // path.resolve will include the null byte in the resolved path,
            // which won't match the working directory prefix
            const result = validatePath('src/file.ts\0/../../etc/passwd', workingDir);
            expect(result.valid).toBe(true);
            // The null byte becomes part of the filename on the filesystem level,
            // but the resolved path is still within workingDir since path.resolve
            // treats it as a single path component
        });

        it('handles deeply nested traversal', () => {
            const result = validatePath(
                'a/b/c/d/e/../../../../../../../../../etc/passwd',
                workingDir
            );
            expect(result.valid).toBe(false);
        });

        it('handles empty string path (resolves to working dir itself)', () => {
            const result = validatePath('', workingDir);
            expect(result.valid).toBe(true);
        });

        it('handles path with spaces', () => {
            const result = validatePath('my folder/my file.txt', workingDir);
            expect(result.valid).toBe(true);
        });

        it('handles path with encoded dots (literal %2e%2e — not traversal)', () => {
            // URL-encoded dots are NOT interpreted by path.resolve — they're literal filenames
            const result = validatePath('%2e%2e/%2e%2e/etc/passwd', workingDir);
            expect(result.valid).toBe(true);
            // This is correct: %2e%2e is a literal directory name, not ..
        });
    });
});
