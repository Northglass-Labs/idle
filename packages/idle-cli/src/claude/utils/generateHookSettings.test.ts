import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ idleHomeDir: '' }));

vi.mock('@/configuration', () => ({
    configuration: {
        get idleHomeDir() {
            return mocked.idleHomeDir;
        },
    },
}));

vi.mock('@/projectPath', () => ({
    projectPath: () => '/opt/idle',
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { cleanupHookSettingsFile, generateHookSettingsFile } from './generateHookSettings';

describe('generateHookSettingsFile', () => {
    beforeEach(async () => {
        mocked.idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-hook-settings-'));
    });

    afterEach(async () => {
        await rm(mocked.idleHomeDir, { recursive: true, force: true });
    });

    it('stores settings and the bearer token in owner-only files', async () => {
        const authToken = 'test-token-that-must-not-appear-in-the-command';
        const settingsPath = generateHookSettingsFile(4242, authToken);
        const tokenPath = settingsPath.replace(/\.json$/, '.token');
        const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
        const command = settings.hooks.SessionStart[0].hooks[0].command as string;

        expect((await stat(join(mocked.idleHomeDir, 'tmp', 'hooks'))).mode & 0o777).toBe(0o700);
        expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
        expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(tokenPath, 'utf8')).toBe(authToken);
        expect(command).toContain('session_hook_forwarder.cjs');
        expect(command).toContain('4242');
        expect(command).toContain(tokenPath);
        expect(command).not.toContain(authToken);

        cleanupHookSettingsFile(settingsPath);
        await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(tokenPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
