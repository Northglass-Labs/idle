import { logger } from "@/ui/logger";
import { watch } from "fs/promises";

export interface FileWatcherOptions {
    /** Invoked once when the target stays absent for the configured timeout. */
    onGaveUp?: () => void;
    /** Maximum continuous absence before the watcher exits. */
    missingFileTimeoutMs?: number;
}

/** Watch one file with bounded absence and exponential retry backoff. */
export function startFileWatcher(
    file: string,
    onFileChange: (file: string) => void,
    options: FileWatcherOptions = {},
) {
    const abortController = new AbortController();
    const missingFileTimeoutMs = options.missingFileTimeoutMs ?? 60_000;

    // Timeout/abort-aware wait so a long backoff does not delay cleanup.
    const wait = (ms: number) => new Promise<void>((resolve) => {
        if (abortController.signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            abortController.signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
    });

    void (async () => {
        // When the target file first went missing (null = currently present
        // or never-yet-missing). Used to bound total absence time.
        let missingSince: number | null = null;
        let failureCount = 0;

        while (true) {
            try {
                logger.debug('[FILE_WATCHER] Starting watcher');
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // The file exists and is being watched — clear failure state.
                    missingSince = null;
                    failureCount = 0;
                    logger.debug('[FILE_WATCHER] File changed');
                    onFileChange(file);
                }
                // Iterator ended without an abort (rare); fall through to retry.
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }

                const isMissing = e?.code === 'ENOENT';
                if (isMissing) {
                    const now = Date.now();
                    if (missingSince === null) {
                        missingSince = now;
                    }
                    const absentMs = now - missingSince;
                    if (absentMs >= missingFileTimeoutMs) {
                        logger.debug('[FILE_WATCHER] Target remained absent; watcher stopped', {
                            absentSeconds: Math.round(absentMs / 1000),
                        });
                        options.onGaveUp?.();
                        return;
                    }
                } else {
                    // Transient error on an (assumed) existing file: back off
                    // and keep retrying, but do not count it as "missing".
                    missingSince = null;
                }

                failureCount++;
                const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
                logger.debug('[FILE_WATCHER] Watch unavailable; retry scheduled', { backoffMs });
                await wait(backoffMs);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
