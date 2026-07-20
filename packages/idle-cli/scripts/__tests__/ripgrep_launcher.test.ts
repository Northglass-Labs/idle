import { execFileSync, spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const launcher = resolve(__dirname, '..', 'ripgrep_launcher.cjs');
const fixtures: string[] = [];

function fixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'idle-ripgrep-fallback-'));
    fixtures.push(root);
    return root;
}

function write(root: string, relativePath: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'fixture');
}

function runWithoutRipgrep(root: string, args: unknown) {
    return spawnSync(process.execPath, [launcher, JSON.stringify(args)], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
    });
}

afterEach(() => {
    for (const root of fixtures.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('ripgrep launcher', () => {
    it('uses a system rg for ordinary local searches when one is available', () => {
        const output = execFileSync(process.execPath, [
            launcher,
            JSON.stringify(['--version']),
        ], {
            encoding: 'utf8',
        });

        expect(output).toMatch(/^ripgrep /);
    });

    it('provides a real deterministic and symlink-safe --files fallback when rg is absent', () => {
        const root = fixtureRoot();
        const outside = fixtureRoot();
        write(root, 'z-last.txt');
        write(root, 'a-first.txt');
        write(root, 'nested/b.txt');
        write(root, 'nested/a.txt');
        write(outside, 'outside-secret.txt');

        for (const ignoredDirectory of [
            '.git',
            '.hidden',
            '.next',
            'build',
            'coverage',
            'dist',
            'node_modules',
            'target',
            'vendor',
        ]) {
            write(root, `${ignoredDirectory}/private.txt`);
        }
        write(root, '.private-file');
        symlinkSync(outside, join(root, 'linked-directory'), 'dir');
        symlinkSync(join(outside, 'outside-secret.txt'), join(root, 'linked-file'));

        const result = runWithoutRipgrep(root, ['--files']);

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe([
            'a-first.txt',
            'nested/a.txt',
            'nested/b.txt',
            'z-last.txt',
            '',
        ].join('\n'));
        expect(result.stdout).not.toContain('private');
        expect(result.stdout).not.toContain('outside');
        expect(result.stdout).not.toContain(outside);
    });

    it('fails closed at a bounded traversal depth without echoing a path or raw error', () => {
        const root = fixtureRoot();
        let relativeDirectory = '';
        for (let depth = 0; depth < 70; depth += 1) {
            relativeDirectory = join(relativeDirectory, `level-${depth}`);
            mkdirSync(join(root, relativeDirectory));
        }
        write(root, join(relativeDirectory, 'too-deep.txt'));

        const result = runWithoutRipgrep(root, ['--files']);

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('File listing unavailable\n');
        expect(result.stderr).not.toContain(root);
        expect(result.stderr).not.toContain('level-');
    });

    it('does not echo malformed input or unsupported search arguments when rg is absent', () => {
        const root = fixtureRoot();
        const malformed = spawnSync(process.execPath, [launcher, 'private-invalid-json-{'], {
            cwd: root,
            encoding: 'utf8',
            env: { ...process.env, PATH: '' },
        });
        const unsupported = runWithoutRipgrep(root, ['private-search-sentinel']);

        expect(malformed.status).toBe(1);
        expect(malformed.stdout).toBe('');
        expect(malformed.stderr).toBe('Invalid search request\n');
        expect(malformed.stderr).not.toContain('private-invalid-json');
        expect(unsupported.status).toBe(1);
        expect(unsupported.stdout).toBe('');
        expect(unsupported.stderr).toBe('System ripgrep is required for content search\n');
        expect(unsupported.stderr).not.toContain('private-search-sentinel');
    });
});
