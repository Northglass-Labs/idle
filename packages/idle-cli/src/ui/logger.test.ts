import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { isPrivateLogTarget, Logger } from './logger';

const tempDirs: string[] = [];
const originalDebug = process.env.DEBUG;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = originalDebug;
});

describe.runIf(process.platform !== 'win32')('Logger file permissions', () => {
  it('creates and repairs the log directory and file as owner-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-test-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o755 });
    const legacyLogPath = join(root, 'logs', 'legacy.log');
    writeFileSync(legacyLogPath, 'legacy', { mode: 0o644 });

    const testLogger = new Logger(logPath);
    testLogger.debug('safe event');
    expect(statSync(dirname(logPath)).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(legacyLogPath).mode & 0o777).toBe(0o600);

    chmodSync(dirname(logPath), 0o755);
    chmodSync(logPath, 0o644);
    testLogger.debug('second safe event');
    expect(statSync(dirname(logPath)).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('redacts credential, identity, URL-query, path, and session values before persistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-redaction-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    const testLogger = new Logger(logPath);

    testLogger.debug(
      'Contact person@personal.example at https://example.test/callback?token=query-secret from /Users/example/private/repo for 123e4567-e89b-12d3-a456-426614174000',
      {
        authorization: 'Bearer header-secret',
        apiKey: 'api-key-secret',
        safeCount: 3,
      },
    );

    const persisted = readFileSync(logPath, 'utf8');
    expect(persisted).not.toContain('person@personal.example');
    expect(persisted).not.toContain('query-secret');
    expect(persisted).not.toContain('/Users/example/private/repo');
    expect(persisted).not.toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(persisted).not.toContain('header-secret');
    expect(persisted).not.toContain('api-key-secret');
    expect(persisted).toContain('safeCount');
    expect(persisted).toContain('[REDACTED]');
  });

  it('does not persist inspected payloads unless DEBUG is explicitly enabled', () => {
    delete process.env.DEBUG;
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-payload-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    const testLogger = new Logger(logPath);

    testLogger.debugLargeJson('remote message', { message: 'private arbitrary prompt' });

    const persisted = readFileSync(logPath, 'utf8');
    expect(persisted).not.toContain('private arbitrary prompt');
  });

  it('persists only payload shape even when DEBUG diagnostics are enabled', () => {
    process.env.DEBUG = '1';
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-debug-shape-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    const testLogger = new Logger(logPath);
    const sentinel = 'OPAQUE_PROVIDER_PAYLOAD_712d';

    testLogger.debugLargeJson('remote payload', {
      arbitraryField: sentinel,
      nested: [{ arbitraryResult: sentinel }],
      enabled: true,
    });

    const persisted = readFileSync(logPath, 'utf8');
    expect(persisted).not.toContain(sentinel);
    expect(persisted).not.toContain('arbitraryField');
    expect(persisted).toContain('fieldCount');
    expect(persisted).toContain('stringBytes');
  });

  it('never persists opaque Error names, codes, or messages from provider boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-error-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    const testLogger = new Logger(logPath);
    const sentinel = 'OPAQUE_PROVIDER_ERROR_a91c7f';
    const opaqueName = 'OpaqueProviderError_a4e2';
    const opaqueCode = 'E_PROVIDER_OPAQUE_7f2b';
    const error = Object.assign(new Error(sentinel), { name: opaqueName, code: opaqueCode });

    testLogger.debug('provider failed', error);

    const persisted = readFileSync(logPath, 'utf8');
    expect(persisted).not.toContain(sentinel);
    expect(persisted).not.toContain(opaqueName);
    expect(persisted).not.toContain(opaqueCode);
    expect(persisted).toContain('Error');
  });

  it('retains only allowlisted diagnostic error metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-known-error-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    const testLogger = new Logger(logPath);
    const error = Object.assign(new TypeError('opaque message'), { code: 'ECONNRESET' });

    testLogger.debug('provider failed', error);

    const persisted = readFileSync(logPath, 'utf8');
    expect(persisted).toContain('TypeError');
    expect(persisted).toContain('ECONNRESET');
    expect(persisted).not.toContain('opaque message');
  });

  it('rejects multiply-linked log targets without altering the linked file', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-hardlink-'));
    tempDirs.push(root);
    const logsDir = join(root, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const protectedPath = join(root, 'protected.txt');
    const logPath = join(logsDir, 'session.log');
    writeFileSync(protectedPath, 'protected-content', { mode: 0o600 });
    linkSync(protectedPath, logPath);
    const testLogger = new Logger(logPath);

    testLogger.debug('must not be written');

    expect(readFileSync(protectedPath, 'utf8')).toBe('protected-content');
    expect(readFileSync(logPath, 'utf8')).toBe('protected-content');
  });

  it('requires a regular, singly-linked, current-owner log target', () => {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const validUid = currentUid ?? 1000;
    const regular = { isFile: () => true, nlink: 1, uid: validUid };

    expect(isPrivateLogTarget(regular, currentUid)).toBe(true);
    expect(isPrivateLogTarget({ ...regular, nlink: 2 }, currentUid)).toBe(false);
    expect(isPrivateLogTarget({ ...regular, uid: validUid + 1 }, currentUid)).toBe(false);
    expect(isPrivateLogTarget({ ...regular, isFile: () => false }, currentUid)).toBe(false);
  });

  it('prunes stale and excess log files during startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-retention-'));
    tempDirs.push(root);
    const logsDir = join(root, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 205; index += 1) {
      const path = join(logsDir, `old-${String(index).padStart(3, '0')}.log`);
      writeFileSync(path, 'old log');
      utimesSync(path, staleDate, staleDate);
    }

    new Logger(join(logsDir, 'current.log'));

    expect(readdirSync(logsDir).filter((file) => file.endsWith('.log')).length).toBeLessThanOrEqual(200);
    expect(readdirSync(logsDir).some((file) => file.startsWith('old-'))).toBe(false);
  });

  it('bounds an individual log file while retaining the newest event', () => {
    const root = mkdtempSync(join(tmpdir(), 'idle-logger-cap-'));
    tempDirs.push(root);
    const logPath = join(root, 'logs', 'session.log');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, Buffer.alloc(11 * 1024 * 1024, 'x'), { mode: 0o600 });
    const testLogger = new Logger(logPath);

    testLogger.debug('newest safe event');

    expect(statSync(logPath).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(readFileSync(logPath, 'utf8')).toContain('newest safe event');
  });
});
