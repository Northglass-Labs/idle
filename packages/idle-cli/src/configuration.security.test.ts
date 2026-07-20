import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let directory = '';
let originalIdleHome: string | undefined;
let originalServerUrl: string | undefined;
let originalWebappUrl: string | undefined;
let originalVariant: string | undefined;

function credentialedTestUrl(hostAndPath: string): string {
  const url = new URL(`https://${hostAndPath}`);
  url.username = 'test-user';
  url.password = 'test-password';
  return url.toString();
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadConfiguration() {
  vi.resetModules();
  return (await import('./configuration')).configuration;
}

describe('configuration settings bootstrap boundary', () => {
  beforeEach(async () => {
    directory = await mkdtemp(`${tmpdir()}/idle-configuration-`);
    originalIdleHome = process.env.IDLE_HOME_DIR;
    originalServerUrl = process.env.IDLE_SERVER_URL;
    originalWebappUrl = process.env.IDLE_WEBAPP_URL;
    originalVariant = process.env.IDLE_VARIANT;
    delete process.env.IDLE_SERVER_URL;
    delete process.env.IDLE_WEBAPP_URL;
  });

  afterEach(async () => {
    restore('IDLE_HOME_DIR', originalIdleHome);
    restore('IDLE_SERVER_URL', originalServerUrl);
    restore('IDLE_WEBAPP_URL', originalWebappUrl);
    restore('IDLE_VARIANT', originalVariant);
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not read API endpoints through a symlinked settings file', async () => {
    const outside = `${directory}/outside.json`;
    await writeFile(outside, JSON.stringify({
      serverUrl: 'https://redirect.invalid',
      webappUrl: 'https://redirect.invalid',
    }), { mode: 0o600 });
    await symlink(outside, `${directory}/settings.json`);
    process.env.IDLE_HOME_DIR = directory;

    const configuration = await loadConfiguration();

    expect(configuration.serverUrl).toMatch(/^https:\/\//);
    expect(configuration.webappUrl).toMatch(/^https:\/\//);
    expect(configuration.serverUrl).not.toBe('https://redirect.invalid');
    expect(configuration.webappUrl).not.toBe('https://redirect.invalid');
  });

  it('bounds bootstrap settings, repairs their mode, and normalizes the Idle home path', async () => {
    const settings = `${directory}/settings.json`;
    await writeFile(settings, JSON.stringify({
      serverUrl: 'https://configured.invalid',
      webappUrl: 'https://configured.invalid',
    }), { mode: 0o600 });
    await chmod(settings, 0o644);
    process.env.IDLE_HOME_DIR = relative(process.cwd(), directory);

    let configuration = await loadConfiguration();
    expect(configuration.idleHomeDir).toBe(resolve(directory));
    expect(configuration.serverUrl).toBe('https://configured.invalid');
    expect((await stat(settings)).mode & 0o777).toBe(0o600);

    await writeFile(settings, JSON.stringify({
      serverUrl: `https://${'x'.repeat(2 * 1024 * 1024)}.invalid`,
    }), { mode: 0o600 });
    configuration = await loadConfiguration();
    expect(configuration.serverUrl).toMatch(/^https:\/\//);
    expect(configuration.serverUrl).not.toContain('x'.repeat(1024));
  });

  it('repairs the Idle home and logs directories to owner-only permissions', async () => {
    await chmod(directory, 0o755);
    process.env.IDLE_HOME_DIR = directory;

    const configuration = await loadConfiguration();

    expect((await stat(configuration.idleHomeDir)).mode & 0o777).toBe(0o700);
    expect((await stat(configuration.logsDir)).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlinked Idle home directory', async () => {
    const target = `${directory}/target`;
    const linkedHome = `${directory}/linked-home`;
    await mkdir(target);
    await symlink(target, linkedHome);
    process.env.IDLE_HOME_DIR = linkedHome;

    await expect(loadConfiguration()).rejects.toThrow(/Idle data directory.*symlink/i);
  });

  it('shows development mode without printing the configured data path', async () => {
    process.env.IDLE_HOME_DIR = directory;
    process.env.IDLE_VARIANT = 'dev';
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await loadConfiguration();

    const output = consoleLog.mock.calls.flat().map(String).join('\n');
    expect(output).toContain('DEV MODE');
    expect(output).not.toContain(directory);
    consoleLog.mockRestore();
  });

  it.each([
    'http://relay.example.test:3005',
    'http://192.168.1.20:3005',
    'http://[fd00::20]:3005',
    credentialedTestUrl('relay.example.test'),
    'https://relay.example.test/v1',
    'https://relay.example.test/?query=1',
    'https://relay.example.test/#fragment',
    ' https://relay.example.test',
  ])('rejects an unsafe environment relay before networking: %s', async (serverUrl) => {
    process.env.IDLE_HOME_DIR = directory;
    process.env.IDLE_SERVER_URL = serverUrl;

    await expect(loadConfiguration()).rejects.toThrow(/server URL/i);
  });

  it.each([
    'http://relay.example.test:3005',
    'http://10.0.0.20:3005',
    'http://[fe80::1]:3005',
  ])('rejects an unsafe persisted relay before networking: %s', async (serverUrl) => {
    await writeFile(`${directory}/settings.json`, JSON.stringify({ serverUrl }), {
      mode: 0o600,
    });
    process.env.IDLE_HOME_DIR = directory;

    await expect(loadConfiguration()).rejects.toThrow(/server URL/i);
  });

  it.each([
    ['https://relay.example.test:8443/', 'https://relay.example.test:8443'],
    ['http://localhost:3005/', 'http://localhost:3005'],
    ['http://127.0.0.1:3005', 'http://127.0.0.1:3005'],
    ['http://[::1]:3005/', 'http://[::1]:3005'],
  ])('accepts and canonicalizes a safe relay: %s', async (serverUrl, expected) => {
    process.env.IDLE_HOME_DIR = directory;
    process.env.IDLE_SERVER_URL = serverUrl;

    expect((await loadConfiguration()).serverUrl).toBe(expected);
  });
});
