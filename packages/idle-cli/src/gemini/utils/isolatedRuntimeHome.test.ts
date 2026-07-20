import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIsolatedGeminiRuntimeHome } from './isolatedRuntimeHome';

describe('createIsolatedGeminiRuntimeHome', () => {
    it('copies only bounded launch state into a private disposable home', () => {
        const root = mkdtempSync(join(tmpdir(), 'idle-gemini-runtime-test-'));
        const sourceHome = join(root, 'source');
        mkdirSync(sourceHome);
        writeFileSync(join(sourceHome, 'oauth_creds.json'), '{"fixture":"oauth"}');
        writeFileSync(join(sourceHome, 'settings.json'), '{"fixture":"settings"}');
        mkdirSync(join(sourceHome, 'history'));
        writeFileSync(join(sourceHome, 'history', 'private.txt'), 'do-not-copy');
        symlinkSync(join(sourceHome, 'oauth_creds.json'), join(sourceHome, 'state.json'));

        const runtime = createIsolatedGeminiRuntimeHome({ sourceHome, temporaryRoot: root });
        try {
            expect(readFileSync(join(runtime.path, '.gemini', 'oauth_creds.json'), 'utf8')).toContain('oauth');
            expect(readFileSync(join(runtime.path, '.gemini', 'settings.json'), 'utf8')).toContain('settings');
            expect(readFileSync(join(runtime.path, 'settings.json'), 'utf8')).toContain('settings');
            expect(existsSync(join(runtime.path, '.gemini', 'history'))).toBe(false);
            expect(existsSync(join(runtime.path, '.gemini', 'state.json'))).toBe(false);
            expect(lstatSync(runtime.path).mode & 0o077).toBe(0);
            expect(runtime.sensitiveSourcePaths).toContain(join(sourceHome, 'oauth_creds.json'));
        } finally {
            runtime.cleanup();
            expect(existsSync(runtime.path)).toBe(false);
            rmSync(root, { recursive: true, force: true });
        }
    });
});
