/**
 * Minimal persistence functions for idle CLI
 *
 * Handles settings and private key storage in ~/.idle/ or local .idle/
 */

import { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, unlink } from 'node:fs/promises'
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import {
  DEFAULT_SANDBOX_DENY_READ_PATHS,
  DEFAULT_SANDBOX_PROVIDER_DOMAINS,
} from '@/security/idleSensitivePaths';

export const SANDBOX_POLICY_VERSION = 2;

export const SandboxConfigSchema = z.object({
  policyVersion: z.literal(SANDBOX_POLICY_VERSION).default(SANDBOX_POLICY_VERSION),
  // Missing policy defaults to OS-level sandboxing enabled.
  // Opt out per-session with `idle --no-sandbox` or persistently via
  // `idle sandbox disable`.
  enabled: z.boolean().default(true),
  workspaceRoot: z.string().optional(),
  sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
  customWritePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default([...DEFAULT_SANDBOX_DENY_READ_PATHS]),
  extraWritePaths: z.array(z.string()).default(['/tmp']),
  denyWritePaths: z.array(z.string()).default(['.env']),
  networkMode: z.enum(['blocked', 'allowed', 'custom']).default('custom'),
  allowedDomains: z.array(z.string()).default([...DEFAULT_SANDBOX_PROVIDER_DOMAINS]),
  deniedDomains: z.array(z.string()).default([]),
  allowLocalBinding: z.boolean().default(false),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

function uniqueStrings(...values: readonly (readonly string[])[]): string[] {
  return [...new Set(values.flat())];
}

function getLegacySandboxCandidate(raw: unknown): unknown | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.policyVersion !== undefined && value.policyVersion !== 1) return null;
  return { ...value, policyVersion: SANDBOX_POLICY_VERSION };
}

function migrateLegacySandboxConfig(parsed: SandboxConfig): SandboxConfig {
  return {
    ...parsed,
    policyVersion: SANDBOX_POLICY_VERSION,
    denyReadPaths: uniqueStrings(DEFAULT_SANDBOX_DENY_READ_PATHS, parsed.denyReadPaths),
    networkMode: parsed.networkMode === 'blocked' ? 'blocked' : 'custom',
    allowedDomains: uniqueStrings(DEFAULT_SANDBOX_PROVIDER_DOMAINS, parsed.allowedDomains),
    allowLocalBinding: false,
  };
}

/**
 * Parse persisted sandbox policy without ever turning malformed policy into
 * an absent (and therefore unenforced) sandbox. An explicit valid opt-out is
 * preserved; corrupt or attacker-edited input returns the enabled defaults.
 */
export function parseSandboxConfigForSettings(raw: unknown): SandboxConfig {
  const legacyCandidate = getLegacySandboxCandidate(raw);
  if (legacyCandidate) {
    const legacyParsed = SandboxConfigSchema.safeParse(legacyCandidate);
    if (legacyParsed.success) {
      return migrateLegacySandboxConfig(legacyParsed.data);
    }
  }

  const parsed = SandboxConfigSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  logger.warn('⚠️ Invalid sandbox config - using secure defaults.');
  return SandboxConfigSchema.parse({});
}

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
export const SUPPORTED_SCHEMA_VERSION = 3;

interface Settings {
  schemaVersion: number
  onboardingCompleted: boolean
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningIdle?: boolean
  chromeMode?: boolean
  sandboxConfig?: SandboxConfig
  serverUrl?: string
  webappUrl?: string
}

// Apply the schema's safe sandbox defaults to new and incomplete settings.
const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  sandboxConfig: SandboxConfigSchema.parse({}),
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  if (fromVersion > SUPPORTED_SCHEMA_VERSION) {
    return { ...raw };
  }
  return { ...raw, schemaVersion: SUPPORTED_SCHEMA_VERSION };
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  /** Owner-only bearer token for the loopback daemon control plane. */
  controlToken?: string;
  startTime: string;
  startedWithCliVersion: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
}

const DaemonLocallyPersistedStateSchema = z.object({
  pid: z.number().int().positive(),
  httpPort: z.number().int().min(1).max(65535),
  controlToken: z.string().min(32).max(256).optional(),
  startTime: z.string().min(1),
  startedWithCliVersion: z.string().min(1),
  lastHeartbeat: z.string().optional(),
  daemonLogPath: z.string().optional(),
});

const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

function writeOwnerOnlyAtomicFile(filePath: string, contents: string): void {
  const tmpFile = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpFile,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, contents, 'utf8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpFile, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
    throw error;
  }
}

export async function readSettings(): Promise<Settings> {
  let fileHandle: FileHandle | undefined;
  try {
    const pathStat = await lstat(configuration.settingsFile);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      return { ...defaultSettings };
    }
    fileHandle = await open(
      configuration.settingsFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const fileStat = await fileHandle.stat();
    if (
      !fileStat.isFile()
      || fileStat.size > MAX_SETTINGS_FILE_BYTES
      || pathStat.dev !== fileStat.dev
      || pathStat.ino !== fileStat.ino
    ) {
      return { ...defaultSettings };
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      await fileHandle.chmod(0o600);
    }

    const content = await fileHandle.readFile({ encoding: 'utf8' });
    const raw = JSON.parse(content)

    // Check schema version (default to 1 if missing)
    const schemaVersion = raw.schemaVersion ?? 1;

    // Warn if schema version is newer than supported
    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      logger.warn(
        `⚠️ Settings schema v${schemaVersion} > supported v${SUPPORTED_SCHEMA_VERSION}. ` +
        'Update idle-cli for full functionality.'
      );
    }

    // Migrate if needed
    const migrated = migrateSettings(raw, schemaVersion);

    if (migrated.sandboxConfig !== undefined) {
      migrated.sandboxConfig = parseSandboxConfigForSettings(migrated.sandboxConfig);
    } else {
      // Missing persisted policy receives the current safe schema defaults;
      // the next settings write makes the default explicit on disk.
      migrated.sandboxConfig = SandboxConfigSchema.parse({});
    }

    // Merge with defaults to ensure all required fields exist
    return { ...defaultSettings, ...migrated };
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ELOOP') {
      logger.warn('Failed to read settings; using secure defaults.');
    }
    return { ...defaultSettings }
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.idleHomeDir)) {
    await mkdir(configuration.idleHomeDir, { recursive: true })
  }

  // Ensure schema version is set before writing
  const settingsWithVersion = {
    ...settings,
    schemaVersion: Math.max(settings.schemaVersion ?? 0, SUPPORTED_SCHEMA_VERSION)
  };

  const encoded = JSON.stringify(settingsWithVersion, null, 2);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SETTINGS_FILE_BYTES) {
    throw new Error('Settings exceeded the allowed size');
  }

  // Atomic replacement prevents a planted symlink from redirecting this
  // security-sensitive policy and endpoint configuration outside ~/.idle.
  writeOwnerOnlyAtomicFile(configuration.settingsFile, encoded);
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  let fileHandle: FileHandle | undefined;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(
        lockFile,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      if (process.platform !== 'win32') {
        await fileHandle.chmod(0o600);
      }
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await lstat(lockFile);
          if (!stats.isFile() || stats.isSymbolicLink() || Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    if (!existsSync(configuration.idleHomeDir)) {
      await mkdir(configuration.idleHomeDir, { recursive: true });
    }

    await writeSettings(updated);

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Authentication
//

const CredentialTokenSchema = z.string().min(1).max(32 * 1024);
const CredentialKeySchema = z.string().min(1).max(256).base64().refine((value) => {
  try {
    return decodeBase64(value).length === 32;
  } catch {
    return false;
  }
});
const credentialsSchema = z.union([
  z.object({
    token: CredentialTokenSchema,
    rpcRegistrationToken: CredentialTokenSchema.optional(),
    secret: CredentialKeySchema,
  }),
  z.object({
    token: CredentialTokenSchema,
    rpcRegistrationToken: CredentialTokenSchema.optional(),
    encryption: z.object({
      publicKey: CredentialKeySchema,
      machineKey: CredentialKeySchema,
    }),
  }),
]);
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export type Credentials = {
  token: string,
  rpcRegistrationToken?: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

/**
 * Remove the obsolete plaintext session-key cache used by early resume builds.
 *
 * Current session encryption no longer reads this cache. Unlinking the path is
 * deliberate: if a local attacker replaced it with a symlink, unlink removes
 * only the link and never follows it to the target.
 */
export async function removeLegacySessionKeyCache(
  idleHomeDir: string = configuration.idleHomeDir,
): Promise<boolean> {
  try {
    await unlink(join(idleHomeDir, 'session-key-cache.json'))
    return true
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(configuration.privateKeyFile);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
    descriptor = openSync(
      configuration.privateKeyFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const fileStat = fstatSync(descriptor);
    if (
      !fileStat.isFile()
      || fileStat.size > MAX_CREDENTIAL_FILE_BYTES
      || pathStat.dev !== fileStat.dev
      || pathStat.ino !== fileStat.ino
    ) {
      return null;
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      fchmodSync(descriptor, 0o600);
    }

    const credentials = credentialsSchema.parse(JSON.parse(readFileSync(descriptor, 'utf8')));
    if ('secret' in credentials) {
      return {
        token: credentials.token,
        ...(credentials.rpcRegistrationToken
          ? { rpcRegistrationToken: credentials.rpcRegistrationToken }
          : {}),
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else {
      return {
        token: credentials.token,
        ...(credentials.rpcRegistrationToken
          ? { rpcRegistrationToken: credentials.rpcRegistrationToken }
          : {}),
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function writeCredentialRecord(record: z.input<typeof credentialsSchema>): void {
  const validated = credentialsSchema.parse(record);
  const tmpFile = `${configuration.privateKeyFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpFile,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify(validated, null, 2), 'utf8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpFile, configuration.privateKeyFile);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
    throw error;
  }
}

export async function writeCredentialsLegacy(credentials: {
  secret: Uint8Array,
  token: string,
  rpcRegistrationToken?: string,
}): Promise<void> {
  if (!existsSync(configuration.idleHomeDir)) {
    await mkdir(configuration.idleHomeDir, { recursive: true })
  }
  // mode 0o600 — this file holds the user's libsodium secret key. Owner-only readable is
  // the minimum bar for any credential file and avoids relying on a permissive umask.
  writeCredentialRecord({
    secret: encodeBase64(credentials.secret),
    token: credentials.token,
    ...(credentials.rpcRegistrationToken
      ? { rpcRegistrationToken: credentials.rpcRegistrationToken }
      : {}),
  });
}

export async function writeCredentialsDataKey(credentials: {
  publicKey: Uint8Array,
  machineKey: Uint8Array,
  token: string,
  rpcRegistrationToken?: string,
}): Promise<void> {
  if (!existsSync(configuration.idleHomeDir)) {
    await mkdir(configuration.idleHomeDir, { recursive: true })
  }
  // mode 0o600 — same rationale as writeCredentialsLegacy.
  writeCredentialRecord({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token,
    ...(credentials.rpcRegistrationToken
      ? { rpcRegistrationToken: credentials.rpcRegistrationToken }
      : {}),
  });
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(
  stateFile: string = configuration.daemonStateFile,
): Promise<DaemonLocallyPersistedState | null> {
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(stateFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      return null;
    }

    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      await fileHandle.chmod(0o600);
    }

    const content = await fileHandle.readFile({ encoding: 'utf-8' });
    const parsed = DaemonLocallyPersistedStateSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      logger.warn('Ignoring invalid daemon control state');
      return null;
    }
    return parsed.data;
  } catch (error: any) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ELOOP') {
      logger.warn('Ignoring unreadable daemon control state');
    }
    return null;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(
  state: DaemonLocallyPersistedState,
  stateFile: string = configuration.daemonStateFile,
): void {
  const validated = DaemonLocallyPersistedStateSchema.parse(state);
  const tmpFile = `${stateFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpFile,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify(validated, null, 2), { encoding: 'utf-8' });
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpFile, stateFile);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    try { unlinkSync(tmpFile); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  // Also clean up lock file if it exists (for stale cleanup)
  if (existsSync(configuration.daemonLockFile)) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      );
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            try {
              process.kill(Number(lockPid), 0); // Check if process exists
            } catch {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    if (existsSync(configuration.daemonLockFile)) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}

// ─── Session persistence (survives daemon restarts) ───

export type PersistedSession = {
  encryptionKey: string;
  encryptionVariant: 'legacy' | 'dataKey';
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
  metadata: Metadata;
  savedAt: number;
};

type SessionsFile = {
  sessions: Record<string, PersistedSession>;
};

const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PERSISTED_SESSIONS = 500;
const MAX_SESSIONS_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_METADATA_BYTES = 256 * 1024;
const PersistedSessionIdSchema = z.string()
  .min(1)
  .max(128)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const PersistedSessionSchema = z.object({
  encryptionKey: z.string().min(1).max(512).refine((value) => {
    try {
      const decoded = decodeBase64(value);
      return decoded.length === 32;
    } catch {
      return false;
    }
  }),
  encryptionVariant: z.enum(['legacy', 'dataKey']),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  metadataVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  agentStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  metadata: z.record(z.string(), z.unknown()).refine((metadata) => {
    try {
      return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_PERSISTED_METADATA_BYTES;
    } catch {
      return false;
    }
  }),
  savedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const SessionsFileSchema = z.object({
  sessions: z.record(PersistedSessionIdSchema, PersistedSessionSchema),
});

export function readPersistedSessions(): Record<string, PersistedSession> {
  let descriptor: number | undefined;
  try {
    if (!existsSync(configuration.sessionsFile)) return {};
    const pathStat = lstatSync(configuration.sessionsFile);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return {};

    descriptor = openSync(
      configuration.sessionsFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const fileStat = fstatSync(descriptor);
    if (
      !fileStat.isFile()
      || fileStat.size > MAX_SESSIONS_FILE_BYTES
      || (pathStat.dev !== fileStat.dev || pathStat.ino !== fileStat.ino)
    ) {
      return {};
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600) {
      fchmodSync(descriptor, 0o600);
    }

    const parsed = SessionsFileSchema.safeParse(JSON.parse(readFileSync(descriptor, 'utf-8')));
    if (!parsed.success) return {};

    const now = Date.now();
    const sessions: Record<string, PersistedSession> = {};
    const newestFirst = Object.entries(parsed.data.sessions)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_PERSISTED_SESSIONS);
    for (const [id, session] of newestFirst) {
      if (now - session.savedAt < SESSION_MAX_AGE_MS) {
        sessions[id] = session as PersistedSession;
      }
    }
    return sessions;
  } catch {
    return {};
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

export function persistSession(sessionId: string, session: PersistedSession): void {
  let descriptor: number | undefined;
  let tmpFile: string | undefined;
  try {
    const validatedId = PersistedSessionIdSchema.parse(sessionId);
    const validatedSession = PersistedSessionSchema.parse(session) as PersistedSession;
    const existing = readPersistedSessions();
    existing[validatedId] = validatedSession;

    const retained: Record<string, PersistedSession> = {};
    let encodedBytes = Buffer.byteLength('{"sessions":{}}', 'utf8');
    for (const [id, candidate] of Object.entries(existing)
      .sort(([, left], [, right]) => right.savedAt - left.savedAt)
      .slice(0, MAX_PERSISTED_SESSIONS)) {
      const entryBytes = Buffer.byteLength(
        `${Object.keys(retained).length > 0 ? ',' : ''}${JSON.stringify(id)}:${JSON.stringify(candidate)}`,
        'utf8',
      );
      if (encodedBytes + entryBytes > MAX_SESSIONS_FILE_BYTES) break;
      retained[id] = candidate;
      encodedBytes += entryBytes;
    }

    const encoded = JSON.stringify({ sessions: retained } satisfies SessionsFile);
    tmpFile = `${configuration.sessionsFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    descriptor = openSync(
      tmpFile,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, encoded, 'utf-8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpFile, configuration.sessionsFile);
    tmpFile = undefined;
  } catch {
    logger.debug('[PERSISTENCE] Failed to persist session');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (tmpFile) {
      try { unlinkSync(tmpFile); } catch { /* best effort */ }
    }
  }
}
