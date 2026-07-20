import { startApi } from "@/app/api/api";
import { log } from "@/utils/log";
import { awaitShutdown, onShutdown } from "@/utils/shutdown";
import { db } from './storage/db';
import { startTimeout } from "./app/presence/timeout";
import { startMetricsServer } from "@/app/monitoring/metrics";
import { activityCache } from "@/app/presence/sessionCache";
import { auth } from "./app/auth/auth";
import { startDatabaseMetricsUpdater } from "@/app/monitoring/metrics2";
import { initEncrypt } from "./modules/encrypt";
import { loadFiles } from "./storage/files";
import { consumeBootSecret } from "@/utils/validateBootSecret";
import { setRuntimeMasterSecret } from "@/utils/runtimeMasterSecret";
import { startAttachmentDeletionWorker } from "@/app/attachments/attachmentDeletionOutbox";

async function main() {

    // Validate before connecting to storage so every production boot fails closed.
    try {
        setRuntimeMasterSecret(consumeBootSecret());
    } catch {
        // Use console.error (in addition to log()) so the message appears prominently in
        // docker logs / systemctl status, where operators are most likely to look.
        console.error('\nFATAL: Cannot start idle-server.');
        console.error('Configure exactly one valid IDLE_MASTER_SECRET or IDLE_MASTER_SECRET_FILE.');
        console.error('');
        log({ module: 'boot', level: 'error' }, 'Idle master secret validation failed');
        process.exit(1);
    }

    // Storage
    await db.$connect();
    onShutdown('db', async () => {
        await db.$disconnect();
    }, 'storage');
    onShutdown('activity-cache', async () => {
        activityCache.shutdown();
    });
    if (process.env.REDIS_URL) {
        const { Redis } = await import('ioredis');
        const redis = new Redis(process.env.REDIS_URL);
        await redis.ping();
    }

    // Initialize auth module
    await initEncrypt();
    await loadFiles();
    startAttachmentDeletionWorker();
    await auth.init();

    //
    // Start
    //

    await startApi();
    await startMetricsServer();
    startDatabaseMetricsUpdater();
    startTimeout();

    //
    // Ready
    //

    log('Ready');
    await awaitShutdown();
    log('Shutting down...');
}

// Process-level error handling
process.on('uncaughtException', (error) => {
    log({
        module: 'process-error',
        level: 'error',
        failureType: error instanceof Error ? 'error' : typeof error,
    }, 'Uncaught exception; terminating');

    console.error('Uncaught exception; terminating. See the sanitized server log.');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    log({
        module: 'process-error',
        level: 'error',
        failureType: reason instanceof Error ? 'error' : typeof reason,
    }, 'Unhandled rejection; terminating');

    console.error('Unhandled rejection; terminating. See the sanitized server log.');
    process.exit(1);
});

process.on('warning', (warning) => {
    log({
        module: 'process-warning',
        level: 'warn',
        failureType: warning instanceof Error ? 'error' : typeof warning,
    }, 'Process warning');
});

// Log when the process is about to exit
process.on('exit', (code) => {
    if (code !== 0) {
        log({
            module: 'process-exit',
            level: 'error',
            exitCode: code
        }, 'Process exiting with failure status');
    } else {
        log({
            module: 'process-exit',
            level: 'info',
            exitCode: code
        }, 'Process exiting normally');
    }
});

main().catch((error) => {
    log({
        module: 'boot',
        level: 'error',
        failureType: error instanceof Error ? 'error' : typeof error,
    }, 'Server boot failed');
    console.error('Server boot failed. See the sanitized server log.');
    process.exit(1);
}).then(() => {
    process.exit(0);
});
