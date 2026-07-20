/**
 * Impression-based prefetch for file contents.
 *
 * When the file list is rendered, this hook prefetches file content + diff
 * for a bounded number of non-deleted, non-binary files that aren't already in the Zustand
 * cache. This way, tapping into a file shows content instantly.
 *
 * Prefetch runs with limited concurrency to avoid overloading
 * the session with too many RPC calls. Deleted and binary files are skipped.
 */

import * as React from 'react';
import { decodeBase64FileContent, FILE_LOAD_LIMITS, mapWithConcurrency } from '@/sync/fileLoadPolicy';
import { sessionGitDiff, sessionReadFile } from '@/sync/ops';
import { getOperationalSessionMetadata, storage } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import type { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
    'mp3', 'wav', 'flac', 'aac', 'ogg',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'rar', '7z',
    'exe', 'dmg', 'deb', 'rpm',
    'woff', 'woff2', 'ttf', 'otf',
    'db', 'sqlite', 'sqlite3',
]);

function isBinaryPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

/**
 * Prefetch a single file's content + diff into the Zustand cache.
 * Silently swallows errors — prefetch is best-effort.
 */
async function prefetchFile(sessionId: string, sessionPath: string, file: GitFileStatus): Promise<void> {
    const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
    const filePath = resolved?.absolutePath ?? file.fullPath;
    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;

    let diff: string | null = null;

    // Fetch git diff
    if (gitDiffPath && gitDiffPath !== '.') {
        try {
            const diffResponse = await sessionGitDiff(sessionId, {
                path: gitDiffPath,
                mode: 'working',
                timeout: 5000,
                maxBytes: FILE_LOAD_LIMITS.prefetch.maxBytesPerResponse,
            });
            if (diffResponse.success && diffResponse.stdout.trim()) {
                diff = diffResponse.stdout;
            }
        } catch {
            // Best-effort
        }
    }

    // Fetch file content
    try {
        const response = await sessionReadFile(
            sessionId,
            filePath,
            FILE_LOAD_LIMITS.prefetch.maxBytesPerResponse,
        );
        if (response.success && response.content) {
            const decoded = decodeBase64FileContent(
                response.content,
                FILE_LOAD_LIMITS.prefetch.maxBytesPerResponse,
            );
            if (!decoded) {
                storage.getState().applyFileCache(sessionId, filePath, '', diff, true);
                return;
            }

            storage.getState().applyFileCache(
                sessionId,
                filePath,
                decoded.isBinary ? '' : decoded.text,
                diff,
                decoded.isBinary,
            );
        }
    } catch {
        // Best-effort
    }
}

export function usePrefetchFileContents(sessionId: string, gitStatusFiles: GitStatusFiles | null) {
    React.useEffect(() => {
        if (!gitStatusFiles) return;

        const session = storage.getState().sessions[sessionId];
        const sessionPathMaybe = getOperationalSessionMetadata(session?.metadata)?.path;
        if (!sessionPathMaybe) return;
        const sessionPath: string = sessionPathMaybe;

        const existingCache = storage.getState().sessionFileCache[sessionId] || {};

        // Collect files that need prefetching: non-deleted, non-binary, not cached
        const filesToPrefetch: GitFileStatus[] = [];
        const seen = new Set<string>();

        collectFiles: for (const group of [gitStatusFiles.stagedFiles, gitStatusFiles.unstagedFiles]) {
            for (const file of group) {
                if (file.status === 'deleted') continue;
                if (isBinaryPath(file.fullPath)) continue;
                if (seen.has(file.fullPath)) continue;
                seen.add(file.fullPath);

                // Check if already cached by resolving the path the same way file.tsx does
                const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
                const absolutePath = resolved?.absolutePath ?? file.fullPath;
                if (existingCache[absolutePath]) continue;

                filesToPrefetch.push(file);
                if (filesToPrefetch.length >= FILE_LOAD_LIMITS.prefetch.maxFiles) {
                    break collectFiles;
                }
            }
        }

        if (filesToPrefetch.length === 0) return;

        let cancelled = false;

        // Run bounded prefetch with limited concurrency.
        (async () => {
            await mapWithConcurrency(
                filesToPrefetch,
                FILE_LOAD_LIMITS.prefetch.maxFiles,
                FILE_LOAD_LIMITS.prefetch.concurrency,
                async (file) => {
                    if (!cancelled) {
                        await prefetchFile(sessionId, sessionPath, file);
                    }
                },
            );
        })();

        return () => {
            cancelled = true;
        };
    }, [sessionId, gitStatusFiles]);
}
