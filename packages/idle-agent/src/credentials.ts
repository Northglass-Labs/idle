import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    unlinkSync,
    writeSync,
    type Stats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, parse, relative, resolve, sep } from 'node:path';
import tweetnacl from 'tweetnacl';
import { normalizeServerUrl } from '@northglass/idle-wire';
import { deriveContentKeyPair, decodeBase64, encodeBase64 } from './encryption';
import type { Config } from './config';

const MAX_CREDENTIAL_FILE_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const CREDENTIAL_SECRET_BYTES = 32;

export type Credentials = {
    token: string;
    secret: Uint8Array;
    accountPublicKey: Uint8Array;
    relayAudience: string;
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

type PathSnapshot = {
    path: string;
    dev: number;
    ino: number;
};

type CredentialPaths = {
    homeDir: string;
    credentialPath: string;
    credentialDir: string;
    directoryPaths: string[];
};

function assertSafeExternalAncestors(homeDir: string): void {
    const root = parse(homeDir).root;
    const components = relative(root, homeDir).split(sep).filter(Boolean);
    let current = root;
    let parentStat = lstatSync(root);

    // The configured home itself is validated later with the stricter
    // credential-directory rules. Here, reject a hidden symlink anywhere
    // above it. macOS exposes root-owned immutable /var and /tmp aliases, so
    // those system entries are the sole compatibility exception.
    for (const component of components.slice(0, -1)) {
        current = resolve(current, component);
        let stat: Stats;
        try {
            stat = lstatSync(current);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }

        if (stat.isSymbolicLink()) {
            const trustedSystemAlias = process.platform !== 'win32'
                && stat.uid === 0
                && parentStat.isDirectory()
                && parentStat.uid === 0
                && (parentStat.mode & 0o022) === 0;
            if (!trustedSystemAlias) {
                throw new Error(`Credential path component is a symbolic link: ${current}`);
            }
        } else if (!stat.isDirectory()) {
            throw new Error(`Credential path component is not a directory: ${current}`);
        }
        parentStat = stat;
    }
}

function noFollowFlag(): number {
    const flag = constants.O_NOFOLLOW;
    if (process.platform !== 'win32' && (!Number.isInteger(flag) || flag === 0)) {
        throw new Error('Secure no-follow credential access is unavailable on this platform');
    }
    return Number.isInteger(flag) ? flag : 0;
}

function getCredentialPaths(config: Config): CredentialPaths {
    const homeDir = resolve(config.homeDir);
    const credentialPath = resolve(config.credentialPath);
    assertSafeExternalAncestors(homeDir);
    const relativeCredential = relative(homeDir, credentialPath);
    if (
        relativeCredential.length === 0
        || relativeCredential === '..'
        || relativeCredential.startsWith(`..${sep}`)
        || resolve(homeDir, relativeCredential) !== credentialPath
    ) {
        throw new Error('Credential file must remain inside IDLE_HOME_DIR');
    }

    const relativeDirectory = dirname(relativeCredential);
    const directoryPaths = [homeDir];
    if (relativeDirectory !== '.') {
        let current = homeDir;
        for (const component of relativeDirectory.split(sep)) {
            if (!component || component === '.' || component === '..') {
                throw new Error('Credential directory contains an invalid component');
            }
            current = resolve(current, component);
            directoryPaths.push(current);
        }
    }

    return {
        homeDir,
        credentialPath,
        credentialDir: dirname(credentialPath),
        directoryPaths,
    };
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function assertOwnedByCurrentUser(stat: Stats, label: string): void {
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
        throw new Error(`${label} is not owned by the current user`);
    }
}

function assertSameInode(expected: Pick<Stats, 'dev' | 'ino'>, actual: Pick<Stats, 'dev' | 'ino'>, label: string): void {
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
        throw new Error(`${label} changed during credential access`);
    }
}

function inspectDirectory(path: string): Stats {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
        throw new Error(`Credential path component is a symbolic link: ${path}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`Credential path component is not a directory: ${path}`);
    }
    assertOwnedByCurrentUser(stat, 'Credential directory');
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
        throw new Error(`Credential directory is writable by another user: ${path}`);
    }
    return stat;
}

function captureDirectoryChain(paths: CredentialPaths): PathSnapshot[] {
    return paths.directoryPaths.map(path => {
        const stat = inspectDirectory(path);
        return { path, dev: stat.dev, ino: stat.ino };
    });
}

function revalidateDirectoryChain(snapshots: PathSnapshot[]): void {
    for (const snapshot of snapshots) {
        const stat = inspectDirectory(snapshot.path);
        assertSameInode(snapshot, stat, 'Credential directory');
    }
}

function ensureCredentialDirectories(paths: CredentialPaths): void {
    for (const path of paths.directoryPaths) {
        try {
            inspectDirectory(path);
        } catch (error) {
            if (!isMissing(error)) throw error;
            try {
                mkdirSync(path, { mode: 0o700 });
            } catch (mkdirError) {
                if ((mkdirError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw mkdirError;
            }
            inspectDirectory(path);
        }
    }

    // IDLE_HOME_DIR is explicitly the credential-store boundary. Keep the
    // final store private without changing unrelated ancestor directories.
    if (process.platform !== 'win32') {
        let descriptor: number | undefined;
        try {
            const pathStat = lstatSync(paths.credentialDir);
            descriptor = openSync(
                paths.credentialDir,
                constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag(),
            );
            const descriptorStat = fstatSync(descriptor);
            assertSameInode(pathStat, descriptorStat, 'Credential directory');
            if (!descriptorStat.isDirectory()) {
                throw new Error('Credential directory is not a directory');
            }
            fchmodSync(descriptor, 0o700);
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }
    }
}

function assertReplaceableCredentialFile(stat: Stats): void {
    if (stat.isSymbolicLink()) {
        throw new Error('Credential target is a symbolic link');
    }
    if (!stat.isFile()) {
        throw new Error('Credential target is not a regular file');
    }
    if (stat.nlink !== 1) {
        throw new Error('Credential target must have exactly one filesystem link');
    }
    assertOwnedByCurrentUser(stat, 'Credential file');
}

function assertSafeCredentialFile(stat: Stats): void {
    assertReplaceableCredentialFile(stat);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error('Credential file exceeds its size limit');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error('Credential file is accessible by another user');
    }
}

function readBoundedDescriptor(descriptor: number, expected: Stats): Buffer {
    const contents = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < contents.length) {
        const bytesRead = readSync(
            descriptor,
            contents,
            offset,
            contents.length - offset,
            offset,
        );
        if (bytesRead <= 0 || bytesRead > contents.length - offset) {
            throw new Error('Credential file changed while reading');
        }
        offset += bytesRead;
    }

    const trailingByte = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailingByte, 0, 1, expected.size) !== 0) {
        throw new Error('Credential file grew while reading');
    }
    return contents;
}

function parseCredentialContents(contents: Buffer, configuredRelayAudience: string): Credentials {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Credential file must contain a JSON object');
    }

    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
        keys.length !== 5
        || keys[0] !== 'accountPublicKey'
        || keys[1] !== 'relayAudience'
        || keys[2] !== 'secret'
        || keys[3] !== 'token'
        || keys[4] !== 'version'
        || record.version !== 3
    ) {
        throw new Error('Credential file has an unexpected schema');
    }
    assertValidToken(record.token);
    if (typeof record.secret !== 'string' || record.secret.length > 64) {
        throw new Error('Credential secret must be bounded canonical base64');
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(record.secret)) {
        throw new Error('Credential secret must be canonical base64');
    }

    const secret = decodeBase64(record.secret);
    if (secret.length !== CREDENTIAL_SECRET_BYTES || encodeBase64(secret) !== record.secret) {
        throw new Error('Credential secret must decode to exactly 32 bytes');
    }

    if (typeof record.accountPublicKey !== 'string' || record.accountPublicKey.length > 64) {
        throw new Error('Credential account identity must be bounded canonical base64');
    }
    const accountPublicKey = decodeBase64(record.accountPublicKey);
    const derivedAccountPublicKey = tweetnacl.sign.keyPair.fromSeed(secret).publicKey;
    if (
        accountPublicKey.length !== CREDENTIAL_SECRET_BYTES
        || encodeBase64(accountPublicKey) !== record.accountPublicKey
        || encodeBase64(derivedAccountPublicKey) !== record.accountPublicKey
    ) {
        throw new Error('Credential account identity does not match its secret');
    }

    if (typeof record.relayAudience !== 'string') {
        throw new Error('Credential relay audience must be a canonical server origin');
    }
    const relayAudience = normalizeServerUrl(record.relayAudience);
    if (
        relayAudience !== record.relayAudience
        || relayAudience !== normalizeServerUrl(configuredRelayAudience)
    ) {
        throw new Error('Credential relay audience does not match the configured server');
    }

    const contentKeyPair = deriveContentKeyPair(secret);
    if (
        contentKeyPair.publicKey.length !== CREDENTIAL_SECRET_BYTES
        || contentKeyPair.secretKey.length !== CREDENTIAL_SECRET_BYTES
    ) {
        throw new Error('Derived content keys must be exactly 32 bytes');
    }
    return { token: record.token, secret, accountPublicKey, relayAudience, contentKeyPair };
}

function assertValidToken(value: unknown): asserts value is string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES
        || /[\u0000-\u0020\u007f]/.test(value)
    ) {
        throw new Error('Credential token is empty, oversized, or contains invalid characters');
    }
}

function assertValidSecret(secret: Uint8Array): void {
    if (!(secret instanceof Uint8Array) || secret.length !== CREDENTIAL_SECRET_BYTES) {
        throw new Error('Credential secret must be exactly 32 bytes');
    }
}

function inspectExistingTarget(path: string, requireSafeContents: boolean): Stats | null {
    try {
        const stat = lstatSync(path);
        if (requireSafeContents) assertSafeCredentialFile(stat);
        else assertReplaceableCredentialFile(stat);
        return stat;
    } catch (error) {
        if (isMissing(error)) return null;
        throw error;
    }
}

export function readCredentials(config: Config): Credentials | null {
    let descriptor: number | undefined;
    try {
        const paths = getCredentialPaths(config);
        const directorySnapshots = captureDirectoryChain(paths);
        const pathStat = inspectExistingTarget(paths.credentialPath, true);
        if (!pathStat) return null;

        descriptor = openSync(paths.credentialPath, constants.O_RDONLY | noFollowFlag());
        const beforeRead = fstatSync(descriptor);
        assertSafeCredentialFile(beforeRead);
        assertSameInode(pathStat, beforeRead, 'Credential file');

        const contents = readBoundedDescriptor(descriptor, beforeRead);
        const afterRead = fstatSync(descriptor);
        assertSafeCredentialFile(afterRead);
        assertSameInode(beforeRead, afterRead, 'Credential file');
        if (
            beforeRead.size !== afterRead.size
            || beforeRead.mtimeMs !== afterRead.mtimeMs
            || beforeRead.ctimeMs !== afterRead.ctimeMs
            || beforeRead.mode !== afterRead.mode
        ) {
            throw new Error('Credential file changed while reading');
        }

        const finalPathStat = lstatSync(paths.credentialPath);
        assertSafeCredentialFile(finalPathStat);
        assertSameInode(beforeRead, finalPathStat, 'Credential file');
        revalidateDirectoryChain(directorySnapshots);
        return parseCredentialContents(contents, config.serverUrl);
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

export function writeCredentials(config: Config, token: string, secret: Uint8Array): void {
    assertValidToken(token);
    assertValidSecret(secret);
    const paths = getCredentialPaths(config);
    const accountPublicKey = tweetnacl.sign.keyPair.fromSeed(secret).publicKey;
    const data = Buffer.from(JSON.stringify({
        version: 3,
        token,
        secret: encodeBase64(secret),
        accountPublicKey: encodeBase64(accountPublicKey),
        relayAudience: normalizeServerUrl(config.serverUrl),
    }), 'utf8');
    if (data.length > MAX_CREDENTIAL_FILE_BYTES) {
        throw new Error('Credential file exceeds its size limit');
    }

    ensureCredentialDirectories(paths);
    const directorySnapshots = captureDirectoryChain(paths);
    const originalTarget = inspectExistingTarget(paths.credentialPath, false);
    const temporaryPath = `${paths.credentialPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let temporaryDescriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    let temporaryExists = false;
    try {
        directoryDescriptor = openSync(
            paths.credentialDir,
            constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag(),
        );
        const directoryStat = fstatSync(directoryDescriptor);
        const expectedDirectory = directorySnapshots[directorySnapshots.length - 1];
        if (!directoryStat.isDirectory()) {
            throw new Error('Credential directory is not a directory');
        }
        assertSameInode(expectedDirectory, directoryStat, 'Credential directory');

        temporaryDescriptor = openSync(
            temporaryPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
            0o600,
        );
        temporaryExists = true;
        let offset = 0;
        while (offset < data.length) {
            const written = writeSync(
                temporaryDescriptor,
                data,
                offset,
                data.length - offset,
                offset,
            );
            if (written <= 0 || written > data.length - offset) {
                throw new Error('Credential file could not be written completely');
            }
            offset += written;
        }
        if (process.platform !== 'win32') fchmodSync(temporaryDescriptor, 0o600);
        fsyncSync(temporaryDescriptor);

        const temporaryStat = fstatSync(temporaryDescriptor);
        assertSafeCredentialFile(temporaryStat);
        if (temporaryStat.size !== data.length) {
            throw new Error('Credential temporary file has an unexpected size');
        }
        closeSync(temporaryDescriptor);
        temporaryDescriptor = undefined;

        revalidateDirectoryChain(directorySnapshots);
        const currentTarget = inspectExistingTarget(paths.credentialPath, false);
        if (originalTarget === null && currentTarget !== null) {
            throw new Error('Credential target appeared during the write');
        }
        if (originalTarget !== null && currentTarget === null) {
            throw new Error('Credential target disappeared during the write');
        }
        if (originalTarget !== null && currentTarget !== null) {
            assertSameInode(originalTarget, currentTarget, 'Credential file');
        }

        renameSync(temporaryPath, paths.credentialPath);
        temporaryExists = false;
        fsyncSync(directoryDescriptor);

        const finalTarget = inspectExistingTarget(paths.credentialPath, true);
        if (!finalTarget || finalTarget.size !== data.length) {
            throw new Error('Credential file was not installed safely');
        }
        revalidateDirectoryChain(directorySnapshots);
    } finally {
        if (temporaryDescriptor !== undefined) {
            try { closeSync(temporaryDescriptor); } catch { /* best effort */ }
        }
        if (temporaryExists) {
            try { unlinkSync(temporaryPath); } catch { /* best effort */ }
        }
        if (directoryDescriptor !== undefined) {
            try { closeSync(directoryDescriptor); } catch { /* best effort */ }
        }
    }
}

export function clearCredentials(config: Config): void {
    let descriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
        const paths = getCredentialPaths(config);
        let directorySnapshots: PathSnapshot[];
        try {
            directorySnapshots = captureDirectoryChain(paths);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
        const pathStat = inspectExistingTarget(paths.credentialPath, false);
        if (!pathStat) return;

        descriptor = openSync(paths.credentialPath, constants.O_RDONLY | noFollowFlag());
        const descriptorStat = fstatSync(descriptor);
        assertReplaceableCredentialFile(descriptorStat);
        assertSameInode(pathStat, descriptorStat, 'Credential file');
        closeSync(descriptor);
        descriptor = undefined;

        revalidateDirectoryChain(directorySnapshots);
        const currentTarget = inspectExistingTarget(paths.credentialPath, false);
        if (!currentTarget) return;
        assertSameInode(pathStat, currentTarget, 'Credential file');

        directoryDescriptor = openSync(
            paths.credentialDir,
            constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag(),
        );
        const directoryStat = fstatSync(directoryDescriptor);
        assertSameInode(
            directorySnapshots[directorySnapshots.length - 1],
            directoryStat,
            'Credential directory',
        );
        unlinkSync(paths.credentialPath);
        fsyncSync(directoryDescriptor);
    } catch (error) {
        if (!isMissing(error)) throw error;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
}

export function requireCredentials(config: Config): Credentials {
    const creds = readCredentials(config);
    if (!creds) {
        throw new Error('Not authenticated. Run `idle-agent auth login` first.');
    }
    return creds;
}
