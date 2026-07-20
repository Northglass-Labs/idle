import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';

const IDENTITY_DIRECTORY = 'session-create-identities-v1';
const MAX_RECORD_BYTES = 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SessionIdentityError extends Error {}

export type SessionCreateIdentity = {
  tagFingerprint: string;
  sessionId: string;
  encryptionKey: Uint8Array;
};

type StoredSessionCreateIdentity = {
  version: 1;
  tagFingerprint: string;
  sessionId: string;
  sealedEncryptionKey: string;
};

function requireWrappingKey(wrappingKey: Uint8Array): Buffer {
  if (!(wrappingKey instanceof Uint8Array) || wrappingKey.length !== 32) {
    throw new SessionIdentityError('Session identity store requires a 32-byte wrapping key');
  }
  return Buffer.from(wrappingKey);
}

function fingerprintTag(tag: string, wrappingKey: Uint8Array): string {
  if (typeof tag !== 'string' || tag.length < 1 || tag.length > 128) {
    throw new SessionIdentityError('Session tag must be between 1 and 128 characters');
  }
  return createHmac('sha256', requireWrappingKey(wrappingKey)).update(tag, 'utf8').digest('hex');
}

function recordAssociatedData(tagFingerprint: string, sessionId: string): Buffer {
  return Buffer.from(`idle-session-create-identity-v1\0${tagFingerprint}\0${sessionId}`, 'utf8');
}

function sealEncryptionKey(
  encryptionKey: Uint8Array,
  wrappingKey: Uint8Array,
  tagFingerprint: string,
  sessionId: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', requireWrappingKey(wrappingKey), nonce);
  cipher.setAAD(recordAssociatedData(tagFingerprint, sessionId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(encryptionKey)),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

function openEncryptionKey(
  sealedEncryptionKey: string,
  wrappingKey: Uint8Array,
  tagFingerprint: string,
  sessionId: string,
): Uint8Array {
  const sealed = Buffer.from(sealedEncryptionKey, 'base64');
  if (sealed.length !== 60 || sealed.toString('base64') !== sealedEncryptionKey) {
    throw new SessionIdentityError('Session identity record is invalid');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      requireWrappingKey(wrappingKey),
      sealed.subarray(0, 12),
    );
    decipher.setAAD(recordAssociatedData(tagFingerprint, sessionId));
    decipher.setAuthTag(sealed.subarray(44));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(12, 44)),
      decipher.final(),
    ]);
    if (plaintext.length !== 32) throw new Error('invalid key length');
    return new Uint8Array(plaintext);
  } catch {
    throw new SessionIdentityError('Session identity record is invalid');
  }
}

async function ensurePrivateDirectory(idleHomeDir: string): Promise<string> {
  await mkdir(idleHomeDir, { recursive: true, mode: 0o700 });
  const homeStat = await lstat(idleHomeDir);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new SessionIdentityError('Idle home directory must be a real directory');
  }

  const directory = join(idleHomeDir, IDENTITY_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new SessionIdentityError('Session identity store must be a real directory');
  }
  if (process.platform !== 'win32' && (directoryStat.mode & 0o777) !== 0o700) {
    await chmod(directory, 0o700);
  }
  return directory;
}

function decodeStoredRecord(
  raw: string,
  expectedFingerprint: string,
  wrappingKey: Uint8Array,
): SessionCreateIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionIdentityError('Session identity record is invalid');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionIdentityError('Session identity record is invalid');
  }
  const record = parsed as Partial<StoredSessionCreateIdentity>;
  if (
    record.version !== 1
    || record.tagFingerprint !== expectedFingerprint
    || !UUID_PATTERN.test(record.sessionId ?? '')
    || typeof record.sealedEncryptionKey !== 'string'
  ) {
    throw new SessionIdentityError('Session identity record is invalid');
  }

  return {
    tagFingerprint: record.tagFingerprint,
    sessionId: record.sessionId!,
    encryptionKey: openEncryptionKey(
      record.sealedEncryptionKey,
      wrappingKey,
      record.tagFingerprint,
      record.sessionId!,
    ),
  };
}

async function readRecord(
  path: string,
  expectedFingerprint: string,
  wrappingKey: Uint8Array,
): Promise<SessionCreateIdentity> {
  const descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await descriptor.stat();
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_RECORD_BYTES) {
      throw new SessionIdentityError('Session identity record is invalid');
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      await descriptor.chmod(0o600);
    }
    return decodeStoredRecord(await descriptor.readFile('utf8'), expectedFingerprint, wrappingKey);
  } finally {
    await descriptor.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY);
  try {
    await descriptor.sync();
  } catch (error: any) {
    // Some supported filesystems do not expose directory fsync. The linked
    // record remains atomic there, even though crash durability is delegated
    // to the filesystem.
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await descriptor.close();
  }
}

async function getOrCreateSessionCreateIdentityInternal(
  tag: string,
  wrappingKey: Uint8Array,
  idleHomeDir: string = configuration.idleHomeDir,
): Promise<SessionCreateIdentity> {
  const tagFingerprint = fingerprintTag(tag, wrappingKey);
  const directory = await ensurePrivateDirectory(idleHomeDir);
  const finalPath = join(directory, `${tagFingerprint}.json`);

  try {
    return await readRecord(finalPath, tagFingerprint, wrappingKey);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const record: SessionCreateIdentity = {
    tagFingerprint,
    sessionId: randomUUID(),
    encryptionKey: new Uint8Array(randomBytes(32)),
  };
  const stored: StoredSessionCreateIdentity = {
    version: 1,
    tagFingerprint,
    sessionId: record.sessionId,
    sealedEncryptionKey: sealEncryptionKey(
      record.encryptionKey,
      wrappingKey,
      tagFingerprint,
      record.sessionId,
    ),
  };
  const encoded = `${JSON.stringify(stored)}\n`;
  const temporaryPath = join(directory, `${tagFingerprint}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);

  let descriptor;
  try {
    descriptor = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await descriptor.writeFile(encoded, 'utf8');
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;

    try {
      await link(temporaryPath, finalPath);
      await syncDirectory(directory);
      return record;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      return await readRecord(finalPath, tagFingerprint, wrappingKey);
    }
  } finally {
    if (descriptor) await descriptor.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export async function getOrCreateSessionCreateIdentity(
  tag: string,
  wrappingKey: Uint8Array,
  idleHomeDir: string = configuration.idleHomeDir,
): Promise<SessionCreateIdentity> {
  try {
    return await getOrCreateSessionCreateIdentityInternal(tag, wrappingKey, idleHomeDir);
  } catch (error) {
    if (error instanceof SessionIdentityError) throw error;
    // Filesystem errors include private absolute paths by default. Keep those
    // details inside the runtime boundary and expose only a stable category.
    throw new SessionIdentityError('Session identity store is unavailable');
  }
}
