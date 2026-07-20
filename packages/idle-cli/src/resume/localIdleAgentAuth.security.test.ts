import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLocalIdleAgentCredentials } from './localIdleAgentAuth';

let directory = '';

function credentialJson(token = 'synthetic-token'): string {
  return JSON.stringify({
    token,
    secret: Buffer.alloc(32, 9).toString('base64'),
  });
}

describe('local Idle Agent credential boundary', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'idle-agent-auth-reader-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses to follow a symlinked agent credential file', async () => {
    const outside = join(directory, 'outside.key');
    const home = join(directory, 'home');
    await writeFile(outside, credentialJson(), { mode: 0o600 });
    await mkdir(home, { mode: 0o700 });
    await symlink(outside, join(home, 'agent.key'));

    expect(readLocalIdleAgentCredentials(home)).toBeNull();
  });

  it('repairs an otherwise valid credential file to owner-only permissions', async () => {
    const path = join(directory, 'agent.key');
    await writeFile(path, credentialJson(), { mode: 0o600 });
    await chmod(path, 0o644);

    expect(readLocalIdleAgentCredentials(directory)).not.toBeNull();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects an oversized credential record before parsing it', async () => {
    await writeFile(join(directory, 'agent.key'), credentialJson('x'.repeat(128 * 1024)), { mode: 0o600 });

    expect(readLocalIdleAgentCredentials(directory)).toBeNull();
  });
});
