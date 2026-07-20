import pino from 'pino';
import pretty from 'pino-pretty';
import { isIP } from 'node:net';

const REDACTED = '[REDACTED]';
const NETWORK_ADDRESS_SENTINEL = '\u0000NETWORK_ADDRESS\u0000';
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|secret|password|passphrase|apiKey|privateKey|encryptionKey|credential|prompt|content|body|input|output|message|title|path|cwd|host|hostname|homeDir|err|error|cause|reason|stack|warning|id|key|ref)$/i;
const IDENTIFIER_KEY = /(?:Id|_id|-id)$/;

function isSensitiveLogKey(key: string): boolean {
    return SENSITIVE_KEY.test(key) || IDENTIFIER_KEY.test(key);
}

function redactNetworkAddresses(value: string): string {
    return value
        .replace(/\[[0-9A-Fa-f:.%]+\](?::\d{1,5})?/g, (candidate) => {
            const closingBracket = candidate.indexOf(']');
            const host = candidate.slice(1, closingBracket).split('%', 1)[0];
            return isIP(host) === 6 ? NETWORK_ADDRESS_SENTINEL : candidate;
        })
        .replace(
            /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}(?:[A-Fa-f0-9]{0,4}|(?:\d{1,3}\.){3}\d{1,3})(?:%[A-Za-z0-9_.-]+)?(?![A-Za-z0-9:.])/g,
            (candidate) => isIP(candidate.split('%', 1)[0]) === 6
                ? NETWORK_ADDRESS_SENTINEL
                : candidate,
        )
        .replace(
            /(?<![A-Za-z0-9_.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![A-Za-z0-9_.])/g,
            (candidate) => {
                const separator = candidate.lastIndexOf(':');
                const host = separator === -1 ? candidate : candidate.slice(0, separator);
                return isIP(host) === 4 ? NETWORK_ADDRESS_SENTINEL : candidate;
            },
        );
}

export function sanitizeServerLogText(value: string): string {
    return redactNetworkAddresses(value)
        .replace(
            /\b((?:error|failed|failure|exception|rejection|threw|warning)(?:\s+[^:\r\n]{0,96})?:)\s*[^\r\n]*/gim,
            '$1 [REDACTED]',
        )
        .replace(
            /\b(prompt|content|body|message|title)\b(?:\s*\([^)]*\))?\s*[:=]\s*.*$/gim,
            (_match, key: string) => `${key}=${REDACTED}`,
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
        .replace(
            /\b(authorization|cookie|set-cookie|token|secret|password|passphrase|api[_-]?key|private[_-]?key|encryption[_-]?key|credential|key|ref)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
            (_match, key: string) => `${key}=${REDACTED}`,
        )
        .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|npm|expo)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
        .replace(/https?:\/\/[^\s'"<>]+/gi, '[URL]')
        .replace(
            /\b((?:idle|claude|codex|gemini|session|thread|device|machine|account|user|request|socket)(?:[_ -]?id)?\s*[:=]\s*)[A-Za-z0-9_-]{8,}/gi,
            `$1${REDACTED}`,
        )
        .replace(
            /\b((?:user|session|thread|device|machine|account|request|socket|artifact|conversation|room)\s+(?:connected|disconnected)\s*:\s*)(?=[A-Za-z0-9._:-]{8,}(?:\b|$))(?=[A-Za-z0-9._:-]*[0-9_.:-])[A-Za-z0-9._:-]+/gi,
            `$1${REDACTED}`,
        )
        .replace(
            /\b((?:user|session|thread|device|machine|account|request|socket|artifact|conversation|room)\s+)(?=[A-Za-z0-9._:-]{8,}(?:\b|$))(?=[A-Za-z0-9._:-]*[0-9_.:-])[A-Za-z0-9._:-]+/gi,
            `$1${REDACTED}`,
        )
        .replace(
            /\b(?=[A-Za-z0-9._:-]{12,}\b)(?=[A-Za-z0-9._:-]*[0-9])[A-Za-z0-9._:-]+\b/g,
            (candidate) => (
                /^\d+(?:\.\d+){1,3}$/.test(candidate)
                || /^\d{1,2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(candidate)
            ) ? candidate : REDACTED,
        )
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, REDACTED)
        .replace(/\/(?:Users|home|private|var|tmp|opt)\/[^\s,'"}\]]+/g, '[PATH]')
        .replace(/[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gi, '[PATH]')
        .split(NETWORK_ADDRESS_SENTINEL).join(REDACTED);
}

export function sanitizeServerLogValue(
    value: unknown,
    seen: WeakSet<object> = new WeakSet(),
    depth = 0,
): unknown {
    if (typeof value === 'string') return sanitizeServerLogText(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 5) return '[MAX DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (value instanceof Error) {
        const errorRecord: Record<string, unknown> = {
            name: /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value.name)
                ? value.name
                : 'Error',
        };
        const code = (value as Error & { code?: unknown }).code;
        if (typeof code === 'number' && Number.isFinite(code)) {
            errorRecord.code = code;
        } else if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) {
            errorRecord.code = code;
        }
        return errorRecord;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 50).map((entry) => sanitizeServerLogValue(entry, seen, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        result[key] = isSensitiveLogKey(key)
            ? REDACTED
            : sanitizeServerLogValue(entry, seen, depth + 1);
    }
    return result;
}

// Format time as HH:MM:ss.mmm in local time
function formatLocalTime(timestamp?: number) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');
    const secs = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hours}:${mins}:${secs}.${ms}`;
}

// IMPORTANT: do NOT use pino's `transport` option here.
//
// pino transports run the target (pino-pretty, pino/file) in a worker_thread,
// which introduces an extra module-resolution boundary in packed runtimes.
//
// Synchronous in-process streams (pino-pretty as a stream + pino.destination,
// composed with pino.multistream) need no worker and no on-disk resolution, so
// they work identically whether packed or run from source.
const prettyStream = pretty({
    colorize: true,
    translateTime: 'HH:MM:ss.l',
    ignore: 'pid,hostname',
    messageFormat: '{levelLabel} {msg} | [{time}]',
    errorLikeObjectKeys: ['err', 'error'],
});

export function serverLogFormatForEnvironment(
    environment: string | undefined,
): 'json' | 'pretty' {
    return environment === 'production' ? 'json' : 'pretty';
}

const loggerStreams: pino.StreamEntry[] = serverLogFormatForEnvironment(process.env.NODE_ENV) === 'json'
    ? [{ level: 'info', stream: pino.destination({ dest: 1, sync: true }) }]
    : [{ level: 'debug', stream: prettyStream }];

// Shared core options: both loggers add localTime to every entry and emit the
// same timestamp shape. Stream selection (pretty/file) is layered on top.
const baseOptions = {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    hooks: {
        logMethod(args: unknown[], method: (...methodArgs: unknown[]) => void) {
            method.apply(this, args.map((arg) => sanitizeServerLogValue(arg)));
        },
    },
    formatters: {
        // A server hostname and PID are local topology, not application
        // diagnostics. Systemd/container metadata can provide them when an
        // operator deliberately needs that correlation.
        bindings: () => ({}),
        log: (object: any) => {
            // Add localTime to every log entry
            return {
                ...(sanitizeServerLogValue(object) as Record<string, unknown>),
                localTime: formatLocalTime(typeof object.time === 'number' ? object.time : undefined),
            };
        },
    },
    timestamp: pino.stdTimeFunctions.epochTime,
} satisfies pino.LoggerOptions;

// Main server logger with local time formatting
export const logger = pino(baseOptions, pino.multistream(loggerStreams));

export function log(src: any, ...args: any[]) {
    // Route to the matching pino level when the caller provides one in the src object
    // (`log({ module: 'x', level: 'error' }, 'msg')`). Without this routing, every event
    // emitted via `log()` lands at info level — which means error events get filtered out
    // of an info-level log config, defeating the per-call severity tagging the rest of the
    // codebase relies on.
    if (src && typeof src === 'object') {
        const level = src.level;
        if (level === 'error') {
            logger.error(src, ...args);
            return;
        }
        if (level === 'warn') {
            logger.warn(src, ...args);
            return;
        }
        if (level === 'debug') {
            logger.debug(src, ...args);
            return;
        }
    }
    logger.info(src, ...args);
}

export function warn(src: any, ...args: any[]) {
    logger.warn(src, ...args);
}

export function error(src: any, ...args: any[]) {
    logger.error(src, ...args);
}

export function debug(src: any, ...args: any[]) {
    logger.debug(src, ...args);
}
