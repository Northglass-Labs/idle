import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedCodexRuntimeHome } from './isolatedRuntimeHome';

describe('createIsolatedCodexRuntimeHome', () => {
    it('creates a private empty home without copying trusted Codex state', () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-codex-runtime-test-'));
        const sourceHome = join(root, 'source');
        mkdirSync(sourceHome);
        writeFileSync(join(sourceHome, 'auth.json'), '{"tokens":{"refresh_token":"do-not-copy"}}', { mode: 0o600 });
        writeFileSync(join(sourceHome, 'config.toml'), 'mcp_secret = "do-not-copy"');
        writeFileSync(join(sourceHome, 'history.jsonl'), 'private prompt history');

        const runtime = createIsolatedCodexRuntimeHome({ sourceHome, temporaryRoot: root });
        try {
            expect(existsSync(join(runtime.path, 'auth.json'))).toBe(false);
            expect(existsSync(join(runtime.path, 'config.toml'))).toBe(false);
            expect(existsSync(join(runtime.path, 'history.jsonl'))).toBe(false);
            expect(lstatSync(runtime.path).mode & 0o077).toBe(0);
            expect(runtime.sourceHome).toBe(realpathSync(sourceHome));
        } finally {
            runtime.cleanup();
            expect(existsSync(runtime.path)).toBe(false);
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('removes private runtime homes left by dead Idle processes', () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-codex-runtime-test-'));
        const sourceHome = join(root, 'source');
        mkdirSync(sourceHome);
        const staleRuntime = join(root, 'idle-codex-runtime-999999-dead-fixture');
        mkdirSync(staleRuntime, { mode: 0o700 });
        writeFileSync(join(staleRuntime, 'state.json'), 'stale', { mode: 0o600 });

        const runtime = createIsolatedCodexRuntimeHome({ sourceHome, temporaryRoot: root });
        try {
            expect(existsSync(staleRuntime)).toBe(false);
            expect(runtime.path).toContain(`idle-codex-runtime-${process.pid}-`);
        } finally {
            runtime.cleanup();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns the canonical source home so sandbox denial covers symlink targets', () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-codex-runtime-test-'));
        const sourceHome = join(root, 'source');
        const sourceLink = join(root, 'source-link');
        mkdirSync(sourceHome);
        symlinkSync(sourceHome, sourceLink);

        const runtime = createIsolatedCodexRuntimeHome({ sourceHome: sourceLink, temporaryRoot: root });
        try {
            expect(runtime.sourceHome).toBe(realpathSync(sourceHome));
        } finally {
            runtime.cleanup();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
