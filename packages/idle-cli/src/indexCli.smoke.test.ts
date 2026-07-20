import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';

const CLI_SMOKE_TEST_TIMEOUT_MS = 15_000;

describe('packaged CLI informational flags', () => {
    it('--version prints only the Idle version and exits before auth or daemon startup', () => {
        const idleHome = mkdtempSync(path.join(tmpdir(), 'idle-version-smoke-'));
        try {
            const result = spawnSync(process.execPath, [path.resolve('bin/idle.mjs'), '--version'], {
                cwd: path.resolve('.'),
                encoding: 'utf8',
                timeout: 10_000,
                env: { ...process.env, IDLE_HOME_DIR: idleHome },
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout.trim()).toBe(`idle version: ${packageJson.version}`);
            expect(result.stderr).toBe('');
        } finally {
            rmSync(idleHome, { recursive: true, force: true });
        }
    }, CLI_SMOKE_TEST_TIMEOUT_MS);

    it('--help presents the multi-provider surface and keeps dangerous mode explicit', () => {
        const idleHome = mkdtempSync(path.join(tmpdir(), 'idle-help-smoke-'));
        try {
            const result = spawnSync(process.execPath, [path.resolve('bin/idle.mjs'), '--help'], {
                cwd: path.resolve('.'),
                encoding: 'utf8',
                timeout: 10_000,
                env: { ...process.env, IDLE_HOME_DIR: idleHome },
            });

            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Remote control for coding agents');
            expect(result.stdout).toContain('Claude is the default provider');
            expect(result.stdout).toContain('Codex');
            expect(result.stdout).toContain('Gemini');
            expect(result.stdout).toContain('OpenClaw');
            expect(result.stdout).toContain('Dangerously skip permission checks');
            expect(result.stdout).not.toContain('Claude Code On the Go');
            expect(result.stdout).not.toContain('supports ALL Claude options');
            expect(result.stdout).not.toContain('manages Claude sessions');
        } finally {
            rmSync(idleHome, { recursive: true, force: true });
        }
    }, CLI_SMOKE_TEST_TIMEOUT_MS);
});
