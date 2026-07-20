import * as fs from 'node:fs';
import * as path from 'node:path';

/** Validate and load the server master secret before any boot path touches storage. */

export interface BootSecretValidationResult {
    ok: boolean;
    error?: string;
}

export interface BootSecretEnvironment {
    [key: string]: string | undefined;
    IDLE_MASTER_SECRET?: string;
    IDLE_MASTER_SECRET_FILE?: string;
}

const MAX_SECRET_FILE_PATH_BYTES = 4096;
const MAX_SECRET_FILE_BYTES = 65;

// Values shipped in committed .env files or commonly used as placeholder secrets.
// Match exactly (case-sensitive — operators who pick a real secret are unlikely to land here).
const REJECTED_PLACEHOLDERS = new Set<string>([
    '',
    'your-super-secret-key-for-local-development',
    'change-me',
    'changeme',
    'changeMe',
    'CHANGEME',
    'secret',
    'password',
    'idle-master-secret',
]);

const HELP_SUFFIX =
    'Generate one with `openssl rand -hex 32` and provide exactly one supported direct or file-backed secret source. See docs/SELF-HOSTING.md for the full setup.';

export function validateBootSecret(value: string | undefined | null): BootSecretValidationResult {
    if (value === undefined || value === null) {
        return {
            ok: false,
            error: `IDLE_MASTER_SECRET is not set. ${HELP_SUFFIX}`,
        };
    }
    if (REJECTED_PLACEHOLDERS.has(value)) {
        return {
            ok: false,
            error: `IDLE_MASTER_SECRET is set to a known placeholder value (${value.length === 0 ? 'empty string' : `"${value}"`}). This is unsafe — anyone with public access to the repo or to this configuration could forge authentication tokens and decrypt a retained legacy GitHub OAuth token. ${HELP_SUFFIX}`,
        };
    }
    if (!/^[0-9a-f]{64}$/i.test(value)) {
        return {
            ok: false,
            error: `IDLE_MASTER_SECRET must contain exactly 64 hexadecimal characters (32 bytes); received ${value.length} characters. ${HELP_SUFFIX}`,
        };
    }
    return { ok: true };
}

function readBootSecretFile(secretPath: string): string {
    if (
        !path.isAbsolute(secretPath)
        || secretPath.includes('\0')
        || Buffer.byteLength(secretPath, 'utf8') > MAX_SECRET_FILE_PATH_BYTES
    ) {
        throw new Error('IDLE_MASTER_SECRET_FILE must be a bounded absolute path.');
    }

    let initialStat: fs.Stats;
    let secretBytes: Buffer | undefined;
    try {
        initialStat = fs.lstatSync(secretPath);
    } catch {
        throw new Error('IDLE_MASTER_SECRET_FILE is unavailable.');
    }
    if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
        throw new Error('IDLE_MASTER_SECRET_FILE must reference a regular file, not a symlink.');
    }
    if (initialStat.nlink !== 1) {
        throw new Error('IDLE_MASTER_SECRET_FILE must have exactly one filesystem link.');
    }

    let descriptor: number;
    try {
        const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
        descriptor = fs.openSync(
            secretPath,
            fs.constants.O_RDONLY | noFollow,
        );
    } catch {
        throw new Error('IDLE_MASTER_SECRET_FILE is unavailable or cannot be opened securely.');
    }

    try {
        const openedStat = fs.fstatSync(descriptor);
        if (
            !openedStat.isFile()
            || openedStat.dev !== initialStat.dev
            || openedStat.ino !== initialStat.ino
        ) {
            throw new Error('IDLE_MASTER_SECRET_FILE changed while it was being opened.');
        }
        let openedPathStat: fs.Stats;
        try {
            openedPathStat = fs.lstatSync(secretPath);
        } catch {
            throw new Error('IDLE_MASTER_SECRET_FILE changed while it was being opened.');
        }
        if (
            openedPathStat.isSymbolicLink()
            || !openedPathStat.isFile()
            || openedPathStat.dev !== openedStat.dev
            || openedPathStat.ino !== openedStat.ino
        ) {
            throw new Error('IDLE_MASTER_SECRET_FILE changed while it was being opened.');
        }
        if (openedStat.nlink !== 1) {
            throw new Error('IDLE_MASTER_SECRET_FILE must have exactly one filesystem link.');
        }
        if (openedStat.size < 64 || openedStat.size > MAX_SECRET_FILE_BYTES) {
            throw new Error('IDLE_MASTER_SECRET_FILE content must be exactly 64 hexadecimal characters with an optional final LF.');
        }

        if (process.platform !== 'win32') {
            const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : undefined;
            if (openedStat.uid !== 0 && openedStat.uid !== effectiveUid) {
                throw new Error('IDLE_MASTER_SECRET_FILE has unsafe ownership.');
            }

            const permissions = openedStat.mode & 0o7777;
            if (permissions !== 0o400 && permissions !== 0o600) {
                throw new Error('IDLE_MASTER_SECRET_FILE has unsafe permissions; use owner-read-only or owner-read-write mode.');
            }
        }

        secretBytes = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
        let offset = 0;
        while (offset < secretBytes.length) {
            const bytesRead = fs.readSync(descriptor, secretBytes, offset, secretBytes.length - offset, null);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > MAX_SECRET_FILE_BYTES) {
            throw new Error('IDLE_MASTER_SECRET_FILE content must be exactly 64 hexadecimal characters with an optional final LF.');
        }

        const encoded = secretBytes.subarray(0, offset).toString('utf8');
        const value = encoded.endsWith('\n') ? encoded.slice(0, -1) : encoded;
        if (encoded !== value && value.endsWith('\r')) {
            throw new Error('IDLE_MASTER_SECRET_FILE content must use an optional LF, not CRLF.');
        }
        if (!validateBootSecret(value).ok) {
            throw new Error('IDLE_MASTER_SECRET_FILE content must be exactly 64 hexadecimal characters with an optional final LF.');
        }
        return value;
    } finally {
        secretBytes?.fill(0);
        fs.closeSync(descriptor);
    }
}

/** Resolve exactly one direct or file-backed secret without logging either value. */
export function loadBootSecret(environment: BootSecretEnvironment = process.env): string {
    const hasDirectSecret = environment.IDLE_MASTER_SECRET !== undefined;
    const hasSecretFile = environment.IDLE_MASTER_SECRET_FILE !== undefined;
    if (Number(hasDirectSecret) + Number(hasSecretFile) !== 1) {
        throw new Error('Configure exactly one of IDLE_MASTER_SECRET or IDLE_MASTER_SECRET_FILE.');
    }

    if (hasSecretFile) {
        return readBootSecretFile(environment.IDLE_MASTER_SECRET_FILE!);
    }

    const value = environment.IDLE_MASTER_SECRET;
    const validation = validateBootSecret(value);
    if (!validation.ok) {
        throw new Error(validation.error);
    }
    return value!;
}

/**
 * Resolve a boot secret and erase both environment source keys before the
 * caller continues. The finally block also clears rejected input so failed
 * boot diagnostics and child processes cannot retain it.
 */
export function consumeBootSecret(environment: BootSecretEnvironment = process.env): string {
    try {
        return loadBootSecret(environment);
    } finally {
        delete environment.IDLE_MASTER_SECRET;
        delete environment.IDLE_MASTER_SECRET_FILE;
    }
}
