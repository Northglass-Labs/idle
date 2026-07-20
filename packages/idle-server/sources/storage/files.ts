import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client } from 'minio';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
    s3public = process.env.S3_PUBLIC_URL!;
}

export { s3client, s3bucket, s3host };

const MAX_EXACT_ATTACHMENT_DELETES = 2_000;
const S3_DELETE_BATCH = 100;

function invalidStorageKey(): Error {
    return new Error('Invalid local storage key');
}

function storageKeyParts(filePath: string): string[] {
    if (!filePath || path.isAbsolute(filePath) || filePath.includes('\\') || filePath.includes('\0')) {
        throw invalidStorageKey();
    }
    const parts = filePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
        throw invalidStorageKey();
    }
    return parts;
}

function validateAttachmentStorageKey(filePath: string): void {
    const parts = storageKeyParts(filePath);
    const valid = parts.length === 4
        && parts[0] === 'sessions'
        && /^[A-Za-z0-9_-]{1,64}$/.test(parts[1]!)
        && parts[2] === 'attachments'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.enc$/.test(parts[3]!);
    if (!valid) throw new Error('Invalid attachment key');
}

function assertExactResolvedPath(
    candidate: string,
    expectedRealPath: string,
    allowMissing = false,
): void {
    try {
        if (fs.realpathSync.native(candidate) !== expectedRealPath) throw invalidStorageKey();
    } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw error;
    }
}

async function assertExactResolvedPathAsync(
    candidate: string,
    expectedRealPath: string,
    allowMissing = false,
): Promise<void> {
    try {
        if (await fs.promises.realpath(candidate) !== expectedRealPath) throw invalidStorageKey();
    } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw error;
    }
}

function ensureLocalBase(): string {
    const base = path.resolve(localFilesDir);
    if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(base);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Local storage base must be a real directory, not a symlink');
    }
    return base;
}

function resolveSafeLocalPath(filePath: string, createParents: boolean): string {
    const parts = storageKeyParts(filePath);
    const base = ensureLocalBase();
    let current = base;
    let expectedRealPath = fs.realpathSync.native(base);
    for (const component of parts.slice(0, -1)) {
        current = path.join(current, component);
        expectedRealPath = path.join(expectedRealPath, component);
        if (!fs.existsSync(current)) {
            if (!createParents) {
                const error = new Error(`Local storage path does not exist: ${component}`) as NodeJS.ErrnoException;
                error.code = 'ENOENT';
                throw error;
            }
            fs.mkdirSync(current, { mode: 0o700 });
        }
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
            throw new Error('Local storage path contains a symlink');
        }
        if (!stat.isDirectory()) {
            throw new Error('Local storage path component is not a directory');
        }
        assertExactResolvedPath(current, expectedRealPath);
    }
    const fullPath = path.join(base, ...parts);
    assertExactResolvedPath(fullPath, path.join(expectedRealPath, parts.at(-1)!), true);
    return fullPath;
}

async function ensureLocalBaseAsync(): Promise<string> {
    const base = path.resolve(localFilesDir);
    await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(base);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Local storage base must be a real directory, not a symlink');
    }
    return base;
}

async function resolveSafeLocalPathAsync(filePath: string, createParents: boolean): Promise<string> {
    const parts = storageKeyParts(filePath);
    const base = await ensureLocalBaseAsync();
    let current = base;
    let expectedRealPath = await fs.promises.realpath(base);
    for (const component of parts.slice(0, -1)) {
        current = path.join(current, component);
        expectedRealPath = path.join(expectedRealPath, component);
        if (createParents) {
            try {
                await fs.promises.mkdir(current, { mode: 0o700 });
            } catch (error) {
                if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            }
        }
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) {
            throw new Error('Local storage path contains a symlink');
        }
        if (!stat.isDirectory()) {
            throw new Error('Local storage path component is not a directory');
        }
        await assertExactResolvedPathAsync(current, expectedRealPath);
    }
    const fullPath = path.join(base, ...parts);
    await assertExactResolvedPathAsync(fullPath, path.join(expectedRealPath, parts.at(-1)!), true);
    return fullPath;
}

function isMissingObjectError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; statusCode?: unknown };
    return candidate.code === 'ENOENT'
        || candidate.code === 'NoSuchKey'
        || candidate.code === 'NotFound'
        || candidate.statusCode === 404;
}

export async function loadFiles() {
    if (useLocalStorage) {
        ensureLocalBase();
        return;
    }
    await s3client.bucketExists(s3bucket);
}

export function getPublicUrl(filePath: string) {
    if (useLocalStorage) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
        return `${baseUrl}/files/${filePath}`;
    }
    return `${s3public}/${filePath}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = await resolveSafeLocalPathAsync(filePath, true);
    const temporaryPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(
            temporaryPath,
            fs.constants.O_WRONLY
                | fs.constants.O_CREAT
                | fs.constants.O_EXCL
                | (fs.constants.O_NOFOLLOW ?? 0),
            0o600,
        );
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(temporaryPath, fullPath);
        await fs.promises.chmod(fullPath, 0o600);
    } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export class LocalFileSizeError extends Error {
    constructor() {
        super('Local storage object size does not match its reservation');
        this.name = 'LocalFileSizeError';
    }
}

/** Stream one exact-size encrypted attachment into an atomic local object. */
export async function putLocalFileStream(
    filePath: string,
    source: Readable,
    expectedBytes: number,
    signal?: AbortSignal,
): Promise<void> {
    validateAttachmentStorageKey(filePath);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
        throw new LocalFileSizeError();
    }

    const fullPath = await resolveSafeLocalPathAsync(filePath, true);
    const temporaryPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(
            temporaryPath,
            fs.constants.O_WRONLY
                | fs.constants.O_CREAT
                | fs.constants.O_EXCL
                | (fs.constants.O_NOFOLLOW ?? 0),
            0o600,
        );

        let receivedBytes = 0;
        const counter = new Transform({
            transform(chunk: Buffer | string, encoding, callback) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
                receivedBytes += bytes.length;
                if (receivedBytes > expectedBytes) {
                    callback(new LocalFileSizeError());
                    return;
                }
                callback(null, bytes);
            },
        });
        const writer = new Writable({
            write(chunk: Buffer | string, encoding, callback) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
                void (async () => {
                    let offset = 0;
                    while (offset < bytes.length) {
                        const { bytesWritten } = await handle!.write(
                            bytes,
                            offset,
                            bytes.length - offset,
                        );
                        if (bytesWritten < 1) throw new Error('Local storage write made no progress');
                        offset += bytesWritten;
                    }
                })().then(() => callback(), callback);
            },
        });
        await pipeline(source, counter, writer, { signal });
        if (receivedBytes !== expectedBytes) throw new LocalFileSizeError();

        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(temporaryPath, fullPath);
        await fs.promises.chmod(fullPath, 0o600);
    } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Open and validate the same descriptor that will back the response stream. */
export async function openBoundedLocalFile(
    filePath: string,
    maxBytes: number,
): Promise<{ size: number; stream: fs.ReadStream }> {
    validateAttachmentStorageKey(filePath);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error('Invalid local read limit');
    }

    const fullPath = await resolveSafeLocalPathAsync(filePath, false);
    const handle = await fs.promises.open(
        fullPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) {
            throw new Error('Local storage object is not a bounded regular file');
        }
        return {
            size: stat.size,
            stream: handle.createReadStream({
                autoClose: true,
                start: 0,
                end: Math.max(0, stat.size - 1),
            }),
        };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

export function isPublicLocalFileKey(filePath: string): boolean {
    try {
        const parts = storageKeyParts(filePath);
        return parts.length > 1 && parts[0] === 'public';
    } catch {
        return false;
    }
}

export function createLocalFileReadStream(filePath: string): fs.ReadStream {
    if (!isPublicLocalFileKey(filePath)) {
        throw invalidStorageKey();
    }
    const fullPath = resolveSafeLocalPath(filePath, false);
    const descriptor = fs.openSync(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) throw new Error('Public storage object is not a regular file');
        return fs.createReadStream(fullPath, { fd: descriptor, autoClose: true });
    } catch (error) {
        fs.closeSync(descriptor);
        throw error;
    }
}

export async function statAttachmentObject(filePath: string): Promise<{ size: number } | null> {
    validateAttachmentStorageKey(filePath);
    if (useLocalStorage) {
        try {
            const fullPath = await resolveSafeLocalPathAsync(filePath, false);
            const handle = await fs.promises.open(
                fullPath,
                fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
            );
            try {
                const stat = await handle.stat();
                if (!stat.isFile()) return null;
                return { size: stat.size };
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (isMissingObjectError(error)) return null;
            throw error;
        }
    }

    try {
        const stat = await s3client.statObject(s3bucket, filePath);
        return Number.isSafeInteger(stat.size) && stat.size >= 0 ? { size: stat.size } : null;
    } catch (error) {
        if (isMissingObjectError(error)) return null;
        throw error;
    }
}

function removeLocalFile(filePath: string): void {
    try {
        const fullPath = resolveSafeLocalPath(filePath, false);
        const stat = fs.lstatSync(fullPath);
        if (stat.isDirectory()) {
            throw new Error('Refusing to delete a directory as an attachment object');
        }
        fs.unlinkSync(fullPath);
    } catch (error) {
        if (!isMissingObjectError(error)) throw error;
    }
}

/** Delete a database-supplied, bounded set of exact attachment keys. */
export async function deleteAttachmentObjects(refs: string[]): Promise<void> {
    if (refs.length > MAX_EXACT_ATTACHMENT_DELETES) {
        throw new Error('Attachment deletion batch exceeds account quota');
    }
    const uniqueRefs = [...new Set(refs)];
    for (const ref of uniqueRefs) validateAttachmentStorageKey(ref);

    if (useLocalStorage) {
        for (const ref of uniqueRefs) removeLocalFile(ref);
        return;
    }

    for (let offset = 0; offset < uniqueRefs.length; offset += S3_DELETE_BATCH) {
        await s3client.removeObjects(s3bucket, uniqueRefs.slice(offset, offset + S3_DELETE_BATCH));
    }
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
