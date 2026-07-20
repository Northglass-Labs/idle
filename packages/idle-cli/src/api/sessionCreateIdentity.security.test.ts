import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { getOrCreateSessionCreateIdentity } from './sessionCreateIdentity';

const createdRoots: string[] = [];
const wrappingKey = new Uint8Array(32).fill(42);

async function createIdleHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'idle-session-identity-'));
  createdRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('durable session creation identity store', () => {
  it('reuses one private record for concurrent calls without persisting the raw tag', async () => {
    const idleHomeDir = await createIdleHome();
    const tag = 'private-workspace-name';

    const records = await Promise.all(
      Array.from({ length: 12 }, () => getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir)),
    );

    expect(new Set(records.map((record) => record.sessionId))).toHaveLength(1);
    expect(new Set(records.map((record) => Buffer.from(record.encryptionKey).toString('hex')))).toHaveLength(1);
    expect(records[0].encryptionKey).toHaveLength(32);

    const identityDir = join(idleHomeDir, 'session-create-identities-v1');
    const files = await readdir(identityDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain(tag);
    expect((await stat(identityDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(identityDir, files[0]))).mode & 0o777).toBe(0o600);
    const stored = await readFile(join(identityDir, files[0]), 'utf8');
    expect(stored).not.toContain(tag);
    expect(stored).not.toContain(Buffer.from(records[0].encryptionKey).toString('base64'));
    expect(files[0]).not.toBe(`${createHash('sha256').update(tag).digest('hex')}.json`);
  });

  it('retains the same identity after acknowledgment so future same-tag responses remain decryptable', async () => {
    const idleHomeDir = await createIdleHome();
    const tag = 'retry-tag';
    const first = await getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir);
    const afterAcknowledgment = await getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir);

    expect(afterAcknowledgment.sessionId).toBe(first.sessionId);
    expect(afterAcknowledgment.encryptionKey).toEqual(first.encryptionKey);
    expect(await readdir(join(idleHomeDir, 'session-create-identities-v1'))).toHaveLength(1);
  });

  it('fails closed when the identity directory is a symlink', async () => {
    const idleHomeDir = await createIdleHome();
    const outside = await createIdleHome();
    const sentinelPath = join(outside, 'sentinel');
    await writeFile(sentinelPath, 'unchanged', { mode: 0o600 });
    await symlink(outside, join(idleHomeDir, 'session-create-identities-v1'));

    await expect(
      getOrCreateSessionCreateIdentity('symlinked-directory', wrappingKey, idleHomeDir),
    ).rejects.toThrow('Session identity store must be a real directory');
    expect(await readFile(sentinelPath, 'utf8')).toBe('unchanged');
  });

  it('fails closed when the identity record is a symlink', async () => {
    const idleHomeDir = await createIdleHome();
    const outside = await createIdleHome();
    const identityDir = join(idleHomeDir, 'session-create-identities-v1');
    await mkdir(identityDir, { mode: 0o700 });
    const sentinelPath = join(outside, 'sentinel');
    await writeFile(sentinelPath, 'unchanged', { mode: 0o600 });
    const tag = 'symlinked-record';
    const fingerprint = createHmac('sha256', wrappingKey).update(tag, 'utf8').digest('hex');
    await symlink(sentinelPath, join(identityDir, `${fingerprint}.json`));

    await expect(
      getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir),
    ).rejects.toThrow(/^Session identity store is unavailable$/);
    expect(await readFile(sentinelPath, 'utf8')).toBe('unchanged');
  });

  it('rejects a tampered sealed key without exposing record contents', async () => {
    const idleHomeDir = await createIdleHome();
    const tag = 'tamper-detection';
    await getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir);
    const identityDir = join(idleHomeDir, 'session-create-identities-v1');
    const [recordName] = await readdir(identityDir);
    const recordPath = join(identityDir, recordName);
    const stored = JSON.parse(await readFile(recordPath, 'utf8')) as { sealedEncryptionKey: string };
    const replacement = stored.sealedEncryptionKey[20] === 'A' ? 'B' : 'A';
    stored.sealedEncryptionKey = `${stored.sealedEncryptionKey.slice(0, 20)}${replacement}${stored.sealedEncryptionKey.slice(21)}`;
    await writeFile(recordPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });

    await expect(
      getOrCreateSessionCreateIdentity(tag, wrappingKey, idleHomeDir),
    ).rejects.toThrow('Session identity record is invalid');
  });
});
