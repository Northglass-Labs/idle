import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ idleHomeDir: '' }));

vi.mock('@/configuration', () => ({
  configuration: {
    get idleHomeDir() { return mocked.idleHomeDir; },
    get sessionsFile() { return join(mocked.idleHomeDir, 'sessions.json'); },
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { persistSession, readPersistedSessions, type PersistedSession } from './persistence';

function session(savedAt = Date.now()): PersistedSession {
  return {
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    encryptionVariant: 'dataKey',
    seq: 1,
    metadataVersion: 1,
    agentStateVersion: 1,
    metadata: {
      path: '/tmp/project',
      host: 'localhost',
      homeDir: '/tmp',
      idleHomeDir: '/tmp/.idle',
      idleLibDir: '/tmp/idle',
      idleToolsDir: '/tmp/idle/tools',
    },
    savedAt,
  };
}

describe('persisted resume sessions', () => {
  beforeEach(async () => {
    mocked.idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-session-store-'));
  });

  afterEach(async () => {
    await rm(mocked.idleHomeDir, { recursive: true, force: true });
  });

  it('stores session encryption material in a regular owner-only file', async () => {
    persistSession('session-1', session());

    const file = await lstat(join(mocked.idleHomeDir, 'sessions.json'));
    expect(file.isFile()).toBe(true);
    expect(file.isSymbolicLink()).toBe(false);
    expect(file.mode & 0o777).toBe(0o600);
    expect(readPersistedSessions()).toHaveProperty('session-1');
  });

  it('does not follow a planted temporary-file symlink when persisting keys', async () => {
    const outsideFile = join(mocked.idleHomeDir, 'outside.txt');
    const predictableTemp = join(mocked.idleHomeDir, 'sessions.json.tmp');
    await writeFile(outsideFile, 'outside-data', { mode: 0o600 });
    await symlink(outsideFile, predictableTemp);

    persistSession('session-1', session());

    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside-data');
    expect((await lstat(join(mocked.idleHomeDir, 'sessions.json'))).isSymbolicLink()).toBe(false);
  });

  it('refuses to load encryption material through a symlinked store', async () => {
    const outsideFile = join(mocked.idleHomeDir, 'outside.json');
    await writeFile(outsideFile, JSON.stringify({
      sessions: { 'session-1': session() },
    }), { mode: 0o600 });
    await symlink(outsideFile, join(mocked.idleHomeDir, 'sessions.json'));

    expect(readPersistedSessions()).toEqual({});
  });
});
