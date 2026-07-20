import chalk from 'chalk'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { inspect } from 'node:util'
import { homedir } from 'node:os'
import { configuration } from '@/configuration'
import { join, basename, dirname } from 'node:path'
// The daemon-state import remains lazy to prevent an initialization cycle.

const MAX_LOG_AGE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_LOG_FILES = 200
const MAX_LOG_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
const MAX_LOG_ENTRY_BYTES = 32 * 1024
const ACTIVE_LOG_FRESHNESS_MS = 5 * 60 * 1000
const REDACTED = '[REDACTED]'

const DIAGNOSTIC_ERROR_NAMES = new Set([
  'AbortError',
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

const DIAGNOSTIC_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED',
  'ERR_NETWORK',
])

const SENSITIVE_OBJECT_KEY = /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|secret|password|passphrase|apiKey|privateKey|encryptionKey|credential|prompt|content|body|input|output|message|title|path|cwd|host|hostname|homeDir|idleHomeDir|.*(?:session|thread|device|machine|account|user|request|message)Id)$/i

/**
 * Consistent date/time formatting functions
 */
function createTimestampForFilename(date: Date = new Date()): string {
  return date.toLocaleString('sv-SE', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(/[: ]/g, '-').replace(/,/g, '') + '-pid-' + process.pid
}

function createTimestampForLogEntry(date: Date = new Date()): string {
  return date.toLocaleTimeString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

function getSessionLogPath(): string {
  const timestamp = createTimestampForFilename()
  const filename = configuration.isDaemonProcess ? `${timestamp}-daemon.log` : `${timestamp}.log`
  return join(configuration.logsDir, filename)
}

function secureLogDirectory(path: string): boolean {
  try {
    if (existsSync(path)) {
      const stats = lstatSync(path)
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false
    } else {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    chmodSync(path, 0o700)
    return true
  } catch {
    return false
  }
}

type PrivateLogTargetStats = {
  isFile: () => boolean;
  nlink: number;
  uid: number;
}

export function isPrivateLogTarget(
  stats: PrivateLogTargetStats,
  currentUid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined,
): boolean {
  return stats.isFile()
    && stats.nlink === 1
    && (currentUid === undefined || stats.uid === currentUid)
}

function appendPrivateLog(filePath: string, content: string): void {
  if (!secureLogDirectory(dirname(filePath))) {
    throw new Error('Log directory is not private')
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const fd = openSync(filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600)
  try {
    const stats = fstatSync(fd)
    if (!isPrivateLogTarget(stats)) throw new Error('Log path is not a private file')
    fchmodSync(fd, 0o600)
    const boundedContent = boundUtf8(content, MAX_LOG_ENTRY_BYTES)
    if (stats.size + Buffer.byteLength(boundedContent, 'utf8') > MAX_LOG_FILE_BYTES) {
      ftruncateSync(fd, 0)
      writeFileSync(fd, '[log rotated after reaching the private-file size limit]\n', 'utf8')
    }
    writeFileSync(fd, boundedContent, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function boundUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  const suffix = '\n[log entry truncated]\n'
  const prefixBytes = Math.max(0, maximumBytes - Buffer.byteLength(suffix, 'utf8'))
  return bytes.subarray(0, prefixBytes).toString('utf8') + suffix
}

function pruneLogFiles(path: string, currentLogPath: string): void {
  if (!secureLogDirectory(path)) return
  try {
    const now = Date.now()
    const logs = readdirSync(path)
      .filter((file) => file.endsWith('.log'))
      .flatMap((file) => {
        const fullPath = join(path, file)
        try {
          const stats = lstatSync(fullPath)
          if (!isPrivateLogTarget(stats) || stats.isSymbolicLink()) return []
          return [{ file, fullPath, modifiedAt: stats.mtimeMs, size: stats.size }]
        } catch {
          return []
        }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)

    let retainedFiles = currentLogPath && !existsSync(currentLogPath) ? 1 : 0
    let retainedBytes = 0
    for (const log of logs) {
      const isCurrent = log.fullPath === currentLogPath
      const isActive = now - log.modifiedAt <= ACTIVE_LOG_FRESHNESS_MS && isLogProcessActive(log.file)
      const isStale = now - log.modifiedAt > MAX_LOG_AGE_MS
      const exceedsCount = retainedFiles >= MAX_LOG_FILES
      const exceedsTotal = retainedBytes + log.size > MAX_LOG_TOTAL_BYTES
      if (!isCurrent && !isActive && (isStale || exceedsCount || exceedsTotal)) {
        unlinkSync(log.fullPath)
        continue
      }
      retainedFiles += 1
      retainedBytes += log.size
    }
  } catch {
    // Retention maintenance must not interrupt an agent session.
  }
}

function isLogProcessActive(filename: string): boolean {
  const match = filename.match(/-pid-(\d+)(?:-daemon)?\.log$/)
  if (!match) return false
  const pid = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function pruneLegacyLogDirectories(currentDirectory: string): void {
  for (const directory of [join(homedir(), '.happy', 'logs'), join(homedir(), '.handy', 'logs')]) {
    if (directory === currentDirectory || !existsSync(directory)) continue
    pruneLogFiles(directory, '')
  }
}

function repairExistingLogFiles(path: string): void {
  if (!secureLogDirectory(path)) return
  try {
    const markerPath = join(path, '.owner-only-permissions-v1')
    if (existsSync(markerPath)) {
      const markerStats = lstatSync(markerPath)
      if (isPrivateLogTarget(markerStats) && !markerStats.isSymbolicLink()) {
        chmodSync(markerPath, 0o600)
        return
      }
    }
    for (const file of readdirSync(path)) {
      if (!file.endsWith('.log')) continue
      const fullPath = join(path, file)
      const stats = lstatSync(fullPath)
      if (isPrivateLogTarget(stats) && !stats.isSymbolicLink()) chmodSync(fullPath, 0o600)
    }
    appendPrivateLog(markerPath, '')
  } catch {
    // Logging must not interrupt an agent session.
  }
}

function sanitizeLogText(value: string): string {
  return value
    .replace(
      /\b(prompt|content|body|message|title)\b(?:\s*\([^)]*\))?\s*[:=]\s*.*$/gim,
      (_match, key: string) => `${key}=${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(authorization|cookie|set-cookie|token|secret|password|passphrase|api[_-]?key|private[_-]?key|encryption[_-]?key|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
      (_match, key: string) => `${key}=${REDACTED}`,
    )
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|npm|expo)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[URL]')
    .replace(
      /\b((?:idle|claude|codex|gemini|session|thread|device|machine|account|user|request)(?:[_ -]?id)?\s*[:=]\s*)[A-Za-z0-9_-]{8,}/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, REDACTED)
    .replace(/\/(?:Users|home|private|var|tmp|opt)\/[^\s,'"}\]]+/g, '[PATH]')
    .replace(/[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gi, '[PATH]')
}

function sanitizeErrorMetadata(value: Error): {
  name: string;
  hasMessage: boolean;
  code?: string;
  hasUnrecognizedCode?: boolean;
} {
  const rawCode = (value as Error & { code?: unknown }).code
  const code = typeof rawCode === 'string' && DIAGNOSTIC_ERROR_CODES.has(rawCode)
    ? rawCode
    : undefined
  return {
    name: DIAGNOSTIC_ERROR_NAMES.has(value.name) ? value.name : 'Error',
    hasMessage: value.message.length > 0,
    ...(code ? { code } : {}),
    ...(rawCode !== undefined && !code ? { hasUnrecognizedCode: true } : {}),
  }
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof value === 'string') return sanitizeLogText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 5) return '[MAX DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (value instanceof Error) {
    return sanitizeErrorMetadata(value)
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeLogValue(entry, seen, depth + 1))
  }

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_OBJECT_KEY.test(key)
      ? REDACTED
      : sanitizeLogValue(entry, seen, depth + 1)
  }
  return result
}

function formatLogArgument(value: unknown): string {
  const sanitized = sanitizeLogValue(value)
  return typeof sanitized === 'string'
    ? sanitized
    : inspect(sanitized, { depth: 5, breakLength: 120 })
}

function summarizeDiagnosticShape(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') {
    return { type: 'string', stringBytes: Buffer.byteLength(value, 'utf8') }
  }
  if (typeof value === 'number') return { type: 'number', finite: Number.isFinite(value) }
  if (typeof value === 'bigint') return { type: 'bigint' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'undefined') return { type: 'undefined' }
  if (typeof value === 'symbol') return { type: 'symbol' }
  if (typeof value === 'function') return { type: 'function' }
  if (depth >= 5) return { type: 'truncated' }
  if (seen.has(value)) return { type: 'circular' }
  seen.add(value)

  if (value instanceof Error) {
    return {
      type: 'error',
      ...sanitizeErrorMetadata(value),
    }
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value.slice(0, 10).map((entry) => summarizeDiagnosticShape(entry, seen, depth + 1)),
    }
  }

  const values = Object.values(value)
  return {
    type: 'object',
    fieldCount: values.length,
    values: values.slice(0, 20).map((entry) => summarizeDiagnosticShape(entry, seen, depth + 1)),
  }
}

export class Logger {
  constructor(
    public readonly logFilePath = getSessionLogPath()
  ) {
    const logDirectory = dirname(this.logFilePath)
    repairExistingLogFiles(logDirectory)
    pruneLogFiles(logDirectory, this.logFilePath)
    if (logDirectory === configuration.logsDir) {
      pruneLegacyLogDirectories(logDirectory)
    }
  }

  // Local time keeps filenames and entries easy to correlate on the host.
  localTimezoneTimestamp(): string {
    return createTimestampForLogEntry()
  }

  debug(message: string, ...args: unknown[]): void {
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, ...args)
  }

  debugLargeJson(
    message: string,
    object: unknown,
    _maxStringLength: number = 100,
    _maxArrayLength: number = 10,
  ): void {
    if (!process.env.DEBUG) {
      this.debug('Skipped inspected payload; set DEBUG explicitly to persist redacted diagnostics')
      return
    }

    const json = JSON.stringify(summarizeDiagnosticShape(object), null, 2)
    this.logToFile(`[${this.localTimezoneTimestamp()}]`, message, '\n', json)
  }

  info(message: string, ...args: unknown[]): void {
    this.logToConsole('info', '', message, ...args)
    this.debug(message, args)
  }

  infoDeveloper(message: string, ...args: unknown[]): void {
    // Always write to debug
    this.debug(message, ...args)

    // Write to info if DEBUG mode is on
    if (process.env.DEBUG) {
      this.logToConsole('info', '[DEV]', message, ...args)
    }
  }

  warn(message: string, ...args: unknown[]): void {
    this.logToConsole('warn', '', message, ...args)
    this.debug(`[WARN] ${message}`, ...args)
  }

  getLogPath(): string {
    return this.logFilePath
  }

  private logToConsole(level: 'debug' | 'error' | 'info' | 'warn', prefix: string, message: string, ...args: unknown[]): void {
    const safeMessage = sanitizeLogText(message)
    const safeArgs = args.map((arg) => sanitizeLogValue(arg))
    switch (level) {
      case 'debug': {
        console.log(chalk.gray(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'error': {
        console.error(chalk.red(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'info': {
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }

      case 'warn': {
        console.log(chalk.yellow(prefix), safeMessage, ...safeArgs)
        break
      }

      default: {
        this.debug('Unknown log level:', level)
        console.log(chalk.blue(prefix), safeMessage, ...safeArgs)
        break
      }
    }
  }

  private logToFile(prefix: string, message: string, ...args: unknown[]): void {
    const safePrefix = sanitizeLogText(prefix)
    const safeMessage = sanitizeLogText(message)
    const logLine = `${safePrefix} ${safeMessage} ${args.map(formatLogArgument).join(' ')}\n`

    // Handle async file path
    try {
      appendPrivateLog(this.logFilePath, logLine)
    } catch {
      if (process.env.DEBUG) {
        throw new Error('Failed to append private log')
      }
      // Diagnostics must not interrupt an agent session.
    }
  }
}

// Shared process logger.
export let logger = new Logger()

/**
 * Information about a log file on disk
 */
export type LogFileInfo = {
  file: string;
  path: string;
  modified: Date;
};

/**
 * List daemon log files in descending modification time order.
 * Returns up to `limit` entries; empty array if none.
 */
export async function listDaemonLogFiles(limit: number = 50): Promise<LogFileInfo[]> {
  try {
    const logsDir = configuration.logsDir;
    if (!existsSync(logsDir)) {
      return [];
    }

    const logs = readdirSync(logsDir)
      .filter(file => file.endsWith('-daemon.log'))
      .map(file => {
        const fullPath = join(logsDir, file);
        const stats = statSync(fullPath);
        return { file, path: fullPath, modified: stats.mtime } as LogFileInfo;
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Prefer the path persisted by the daemon if present (return 0th element if present)
    try {
      // Lazy import to avoid circular dependency: logger.ts ↔ persistence.ts
      const { readDaemonState } = await import('@/persistence');
      const state = await readDaemonState();

      if (!state) {
        return logs;
      }

      if (state.daemonLogPath && existsSync(state.daemonLogPath)) {
        const stats = statSync(state.daemonLogPath);
        const persisted: LogFileInfo = {
          file: basename(state.daemonLogPath),
          path: state.daemonLogPath,
          modified: stats.mtime
        };
        const idx = logs.findIndex(l => l.path === persisted.path);
        if (idx >= 0) {
          const [found] = logs.splice(idx, 1);
          logs.unshift(found);
        } else {
          logs.unshift(persisted);
        }
      }
    } catch {
      // Ignore errors reading daemon state; fall back to directory listing
    }

    return logs.slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/**
 * Get the most recent daemon log file, or null if none exist.
 */
export async function getLatestDaemonLog(): Promise<LogFileInfo | null> {
  const [latest] = await listDaemonLogFiles(1);
  return latest || null;
}
