import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ idleHomeDir: '' }));

vi.mock('@/configuration', () => ({
  configuration: {
    get idleHomeDir() { return mocked.idleHomeDir; },
    get privateKeyFile() { return join(mocked.idleHomeDir, 'access.key'); },
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import {
  readCredentials,
  writeCredentialsDataKey,
  writeCredentialsLegacy,
} from './persistence';

describe('CLI credential file boundary', () => {
  beforeEach(async () => {
    mocked.idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-cli-credentials-'));
  });

  afterEach(async () => {
    await rm(mocked.idleHomeDir, { recursive: true, force: true });
  });

  it('atomically replaces a symlink without overwriting its target', async () => {
    const outside = join(mocked.idleHomeDir, 'outside.txt');
    const credentials = join(mocked.idleHomeDir, 'access.key');
    await writeFile(outside, 'outside-data', { mode: 0o600 });
    await symlink(outside, credentials);

    await writeCredentialsLegacy({
      secret: new Uint8Array(32).fill(3),
      token: 'synthetic-token',
      rpcRegistrationToken: 'rpc-registration-token',
    });

    await expect(readFile(outside, 'utf8')).resolves.toBe('outside-data');
    const credentialStat = await lstat(credentials);
    expect(credentialStat.isFile()).toBe(true);
    expect(credentialStat.isSymbolicLink()).toBe(false);
    expect(credentialStat.mode & 0o777).toBe(0o600);
    await expect(readCredentials()).resolves.toMatchObject({
      token: 'synthetic-token',
      rpcRegistrationToken: 'rpc-registration-token',
    });
  });

  it('refuses to read credentials through a symlink', async () => {
    const outside = join(mocked.idleHomeDir, 'outside.json');
    await writeFile(outside, JSON.stringify({
      secret: Buffer.alloc(32, 4).toString('base64'),
      token: 'synthetic-token',
    }), { mode: 0o600 });
    await symlink(outside, join(mocked.idleHomeDir, 'access.key'));

    await expect(readCredentials()).resolves.toBeNull();
  });

  it('rejects oversized records and preserves the data-key format', async () => {
    await writeFile(join(mocked.idleHomeDir, 'access.key'), JSON.stringify({
      secret: Buffer.alloc(32, 5).toString('base64'),
      token: 'x'.repeat(128 * 1024),
    }), { mode: 0o600 });
    expect((await readCredentials()) === null).toBe(true);

    await writeCredentialsDataKey({
      publicKey: new Uint8Array(32).fill(6),
      machineKey: new Uint8Array(32).fill(7),
      token: 'data-key-token',
      rpcRegistrationToken: 'rpc-registration-token',
    });
    await expect(readCredentials()).resolves.toMatchObject({
      token: 'data-key-token',
      rpcRegistrationToken: 'rpc-registration-token',
      encryption: { type: 'dataKey' },
    });
  });
});
