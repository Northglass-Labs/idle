const KIB = 1024;
const MIB = 1024 * KIB;

export const FILE_LOAD_LIMITS = {
    rpc: {
        maxBytes: 8 * MIB,
    },
    prefetch: {
        maxFiles: 16,
        maxBytesPerResponse: 256 * KIB,
        concurrency: 2,
    },
    allDiff: {
        maxFiles: 32,
        maxBytesPerResponse: 256 * KIB,
        concurrency: 3,
    },
    explicitOpen: {
        maxBytesPerResponse: 4 * MIB,
    },
    cache: {
        maxEntriesPerSession: 32,
        maxApproxBytesPerSession: 8 * MIB,
        maxSessions: 8,
        maxApproxBytesTotal: 16 * MIB,
    },
    fileSearch: {
        maxOutputBytes: 1 * MIB,
        maxFiles: 5_000,
        maxDirectories: 5_000,
        maxPathLength: 4_096,
    },
    gitStatus: {
        maxOutputCharacters: 1 * MIB,
        maxFiles: 10_000,
    },
} as const;

export function resolveFileResponseLimit(requested: number | undefined, fallback: number): number | null {
    const value = requested ?? fallback;
    return Number.isInteger(value) && value >= 1 && value <= FILE_LOAD_LIMITS.rpc.maxBytes
        ? value
        : null;
}

export interface DecodedFileContent {
    text: string;
    bytes: Uint8Array;
    byteLength: number;
    isBinary: boolean;
}

export interface SessionFileCacheEntry {
    content: string | null;
    diff: string | null;
    isBinary: boolean;
    cachedAt: number;
}

export function maxBase64Length(maxBytes: number): number {
    return Math.ceil(maxBytes / 3) * 4;
}

export function base64DecodedLength(base64: string): number {
    if (base64.length === 0) return 0;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor(base64.length * 3 / 4) - padding;
}

export function exceedsUtf8ByteLimit(values: readonly string[], maxBytes: number): boolean {
    let remaining = Math.max(0, Math.trunc(maxBytes));
    for (const value of values) {
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            let byteLength: number;
            if (code <= 0x7f) {
                byteLength = 1;
            } else if (code <= 0x7ff) {
                byteLength = 2;
            } else if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    byteLength = 4;
                    index += 1;
                } else {
                    byteLength = 3;
                }
            } else {
                byteLength = 3;
            }

            remaining -= byteLength;
            if (remaining < 0) return true;
        }
    }
    return false;
}

export function decodeBase64FileContent(base64: string, maxBytes: number): DecodedFileContent | null {
    if (
        !Number.isInteger(maxBytes)
        || maxBytes < 1
        || base64.length > maxBase64Length(maxBytes)
        || base64DecodedLength(base64) > maxBytes
    ) {
        return null;
    }

    try {
        const binary = atob(base64);
        if (binary.length > maxBytes) {
            return null;
        }

        const bytes = new Uint8Array(binary.length);
        let hasNullByte = false;
        let nonPrintableCount = 0;
        for (let index = 0; index < binary.length; index += 1) {
            const byte = binary.charCodeAt(index);
            bytes[index] = byte;
            if (byte === 0) hasNullByte = true;
            if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
                nonPrintableCount += 1;
            }
        }

        const isBinary = hasNullByte || (bytes.byteLength > 0 && nonPrintableCount / bytes.byteLength > 0.1);
        return {
            text: isBinary ? '' : new TextDecoder().decode(bytes),
            bytes,
            byteLength: bytes.byteLength,
            isBinary,
        };
    } catch {
        return null;
    }
}

export function selectBoundedFiles<T extends { fullPath: string }>(
    files: readonly T[],
    maxFiles: number,
    preferredPath?: string | null,
): T[] {
    const limit = Math.max(0, Math.trunc(maxFiles));
    if (limit === 0 || files.length === 0) return [];
    if (files.length <= limit) return [...files];

    const selected = files.slice(0, limit);
    if (!preferredPath || selected.some((file) => file.fullPath === preferredPath)) {
        return selected;
    }

    const preferred = files.find((file) => file.fullPath === preferredPath);
    if (preferred) {
        selected[selected.length - 1] = preferred;
    }
    return selected;
}

export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    maxItems: number,
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const bounded = items.slice(0, Math.max(0, Math.trunc(maxItems)));
    if (bounded.length === 0) return [];

    const results = new Array<R>(bounded.length);
    let nextIndex = 0;
    const workerCount = Math.min(
        bounded.length,
        Math.max(1, Math.trunc(concurrency)),
    );

    async function runWorker(): Promise<void> {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= bounded.length) return;
            results[index] = await worker(bounded[index], index);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

export function parseBoundedFilePaths(
    output: string,
    limits: { maxFiles: number; maxPathLength: number },
): string[] {
    const paths: string[] = [];
    const maxFiles = Math.max(0, Math.trunc(limits.maxFiles));
    const maxPathLength = Math.max(1, Math.trunc(limits.maxPathLength));
    let start = 0;

    while (start <= output.length && paths.length < maxFiles) {
        const newline = output.indexOf('\n', start);
        const end = newline === -1 ? output.length : newline;
        const path = output.slice(start, end).replace(/\r$/, '');
        if (path.length > 0 && path.length <= maxPathLength && path.trim().length > 0) {
            paths.push(path);
        }
        if (newline === -1) break;
        start = newline + 1;
    }

    return paths;
}

function approximateEntryBytes(path: string, entry: SessionFileCacheEntry): number {
    return 2 * (
        path.length
        + (entry.content?.length ?? 0)
        + (entry.diff?.length ?? 0)
    );
}

export function limitSessionFileCache(
    entries: Record<string, SessionFileCacheEntry>,
    limits: { maxEntries: number; maxApproxBytes: number } = {
        maxEntries: FILE_LOAD_LIMITS.cache.maxEntriesPerSession,
        maxApproxBytes: FILE_LOAD_LIMITS.cache.maxApproxBytesPerSession,
    },
): Record<string, SessionFileCacheEntry> {
    const maxEntries = Math.max(0, Math.trunc(limits.maxEntries));
    const maxApproxBytes = Math.max(0, Math.trunc(limits.maxApproxBytes));
    const kept: Array<[string, SessionFileCacheEntry]> = [];
    let usedBytes = 0;

    const newestFirst = Object.entries(entries)
        .sort((left, right) => right[1].cachedAt - left[1].cachedAt);

    for (const [path, entry] of newestFirst) {
        if (kept.length >= maxEntries) break;
        const entryBytes = approximateEntryBytes(path, entry);
        if (entryBytes > maxApproxBytes - usedBytes) continue;
        kept.push([path, entry]);
        usedBytes += entryBytes;
    }

    return Object.fromEntries(kept);
}

export function limitAllSessionFileCaches(
    caches: Record<string, Record<string, SessionFileCacheEntry>>,
): Record<string, Record<string, SessionFileCacheEntry>> {
    const sessions = Object.entries(caches)
        .map(([sessionId, entries]) => ({
            sessionId,
            entries: limitSessionFileCache(entries),
            newest: Math.max(0, ...Object.values(entries).map((entry) => entry.cachedAt)),
        }))
        .filter((session) => Object.keys(session.entries).length > 0)
        .sort((left, right) => right.newest - left.newest)
        .slice(0, FILE_LOAD_LIMITS.cache.maxSessions);

    const limited: Record<string, Record<string, SessionFileCacheEntry>> = {};
    let remainingBytes = FILE_LOAD_LIMITS.cache.maxApproxBytesTotal;
    for (const session of sessions) {
        const entries = limitSessionFileCache(session.entries, {
            maxEntries: FILE_LOAD_LIMITS.cache.maxEntriesPerSession,
            maxApproxBytes: remainingBytes,
        });
        if (Object.keys(entries).length === 0) continue;
        limited[session.sessionId] = entries;
        for (const [path, entry] of Object.entries(entries)) {
            remainingBytes -= approximateEntryBytes(path, entry);
        }
        if (remainingBytes <= 0) break;
    }
    return limited;
}
