import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ idleHomeDir: '' }));

vi.mock('@/configuration', () => ({
  configuration: {
    get idleHomeDir() { return mocked.idleHomeDir; },
    get settingsFile() { return join(mocked.idleHomeDir, 'settings.json'); },
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { readSettings, updateSettings, writeSettings } from './persistence';

describe('CLI settings file boundary', () => {
  beforeEach(async () => {
    mocked.idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-cli-settings-'));
  });

  afterEach(async () => {
    await rm(mocked.idleHomeDir, { recursive: true, force: true });
  });

  it('refuses to read settings through a symlink', async () => {
    const outside = join(mocked.idleHomeDir, 'outside.json');
    await writeFile(outside, JSON.stringify({
      schemaVersion: 2,
      onboardingCompleted: true,
      machineId: 'outside-machine-id',
    }), { mode: 0o600 });
    await symlink(outside, join(mocked.idleHomeDir, 'settings.json'));

    const loaded = await readSettings();
    expect(loaded).toMatchObject({ onboardingCompleted: false });
    expect(loaded).not.toHaveProperty('machineId');
  });

  it('atomically replaces a symlink without overwriting its target', async () => {
    const outside = join(mocked.idleHomeDir, 'outside.json');
    const settings = join(mocked.idleHomeDir, 'settings.json');
    await writeFile(outside, 'outside-data', { mode: 0o600 });
    await symlink(outside, settings);

    await writeSettings({
      schemaVersion: 2,
      onboardingCompleted: true,
    });

    await expect(readFile(outside, 'utf8')).resolves.toBe('outside-data');
    const settingsStat = await lstat(settings);
    expect(settingsStat.isFile()).toBe(true);
    expect(settingsStat.isSymbolicLink()).toBe(false);
    expect(settingsStat.mode & 0o777).toBe(0o600);
  });

  it('does not follow a planted predictable update tempfile symlink', async () => {
    const outside = join(mocked.idleHomeDir, 'outside.txt');
    await writeFile(outside, 'outside-data', { mode: 0o600 });
    await symlink(outside, join(mocked.idleHomeDir, 'settings.json.tmp'));

    await updateSettings((settings) => ({
      ...settings,
      onboardingCompleted: true,
    }));

    await expect(readFile(outside, 'utf8')).resolves.toBe('outside-data');
    await expect(readSettings()).resolves.toMatchObject({ onboardingCompleted: true });
  });

  it('repairs owner-readable permissions and rejects oversized settings', async () => {
    const settings = join(mocked.idleHomeDir, 'settings.json');
    await writeFile(settings, JSON.stringify({
      schemaVersion: 2,
      onboardingCompleted: true,
    }), { mode: 0o600 });
    await chmod(settings, 0o644);

    await expect(readSettings()).resolves.toMatchObject({ onboardingCompleted: true });
    expect((await lstat(settings)).mode & 0o777).toBe(0o600);

    await writeFile(settings, JSON.stringify({
      schemaVersion: 2,
      onboardingCompleted: true,
      padding: 'x'.repeat(2 * 1024 * 1024),
    }), { mode: 0o600 });
    await expect(readSettings()).resolves.toMatchObject({ onboardingCompleted: false });
  });

  it('uses provider-only networking and the complete credential deny list when policy is absent', async () => {
    const loaded = await readSettings();

    expect(loaded.sandboxConfig).toMatchObject({
      policyVersion: 2,
      enabled: true,
      networkMode: 'custom',
      allowLocalBinding: false,
    });
    expect(loaded.sandboxConfig?.allowedDomains).toContain('api.openai.com');
    expect(loaded.sandboxConfig?.denyReadPaths).toEqual(expect.arrayContaining([
      '~/.ssh',
      '~/.config/gh',
      '~/.config/gcloud',
      '~/Library/Application Support/Google/Chrome',
    ]));
  });

  it('migrates the valid legacy automatic allow-all policy in schema-v1 settings', async () => {
    await writeFile(join(mocked.idleHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 1,
      onboardingCompleted: true,
      sandboxConfig: {
        enabled: true,
        networkMode: 'allowed',
        allowLocalBinding: true,
      },
    }), { mode: 0o600 });

    const loaded = await readSettings();

    expect(loaded).toMatchObject({ schemaVersion: 3, onboardingCompleted: true });
    expect(loaded.sandboxConfig).toMatchObject({
      policyVersion: 2,
      networkMode: 'custom',
      allowLocalBinding: false,
    });
    expect(loaded.sandboxConfig?.denyReadPaths).toContain('~/.config/gh');
  });
});
