import { createHash } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    constants,
    fchmodSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { RPC_REPLAY_MARKER_RETENTION_MS } from '@northglass/idle-wire';

const DEFAULT_MAX_REPLAY_MARKERS = 4_096;
const MARKER_NAME = /^[a-f0-9]{64}\.seen$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type ReplayConsumptionResult = 'consumed' | 'replay' | 'saturated';

interface DurableRpcReplayStoreConfig {
    directory: string;
    maxEntries?: number;
    retentionMs?: number;
}

/**
 * Process-independent replay ledger for authenticated RPC request identities.
 *
 * Marker names are SHA-256 digests and marker bodies contain only a format
 * version. Neither RPC params nor their scope/method/request ID are persisted.
 */
export class DurableRpcReplayStore {
    private readonly directory: string;
    private readonly maxEntries: number;
    private readonly retentionMs: number;

    constructor(config: DurableRpcReplayStoreConfig) {
        if (!Number.isSafeInteger(config.maxEntries ?? DEFAULT_MAX_REPLAY_MARKERS)
            || (config.maxEntries ?? DEFAULT_MAX_REPLAY_MARKERS) < 1) {
            throw new Error('Invalid RPC replay marker capacity');
        }
        if (!Number.isSafeInteger(config.retentionMs ?? RPC_REPLAY_MARKER_RETENTION_MS)
            || (config.retentionMs ?? RPC_REPLAY_MARKER_RETENTION_MS) < 1) {
            throw new Error('Invalid RPC replay marker retention');
        }

        this.directory = config.directory;
        this.maxEntries = config.maxEntries ?? DEFAULT_MAX_REPLAY_MARKERS;
        this.retentionMs = config.retentionMs ?? RPC_REPLAY_MARKER_RETENTION_MS;
    }

    consume(scope: string, requestId: string, now: number): ReplayConsumptionResult {
        this.ensureOwnerOnlyDirectory();
        this.pruneExpiredMarkers(now);

        const markerPath = join(this.directory, this.markerName(scope, requestId));
        let descriptor: number | undefined;
        try {
            descriptor = openSync(
                markerPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
                0o600,
            );
            fchmodSync(descriptor, 0o600);
            writeFileSync(descriptor, 'v1\n', 'utf8');
            fsyncSync(descriptor);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                return 'replay';
            }
            throw error;
        } finally {
            if (descriptor !== undefined) {
                closeSync(descriptor);
            }
        }

        if (this.countMarkers() > this.maxEntries) {
            // Never evict an accepted identity to make room. Removing only
            // this just-created marker keeps the store fail-closed while
            // preserving replay protection for every dispatched operation.
            unlinkSync(markerPath);
            this.syncDirectory();
            return 'saturated';
        }

        this.syncDirectory();
        return 'consumed';
    }

    private ensureOwnerOnlyDirectory(): void {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const stat = lstatSync(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Invalid RPC replay marker directory');
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('RPC replay marker directory has the wrong owner');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
            chmodSync(this.directory, 0o700);
        }
    }

    private pruneExpiredMarkers(now: number): void {
        const expirationBoundary = now - this.retentionMs;
        for (const entry of readdirSync(this.directory)) {
            this.assertMarkerName(entry);
            const markerPath = join(this.directory, entry);
            const stat = lstatSync(markerPath);
            this.assertRegularOwnedMarker(stat);
            if (stat.mtimeMs < expirationBoundary) {
                unlinkSync(markerPath);
            }
        }
    }

    private countMarkers(): number {
        const entries = readdirSync(this.directory);
        for (const entry of entries) {
            this.assertMarkerName(entry);
            this.assertRegularOwnedMarker(lstatSync(join(this.directory, entry)));
        }
        return entries.length;
    }

    private assertMarkerName(entry: string): void {
        if (!MARKER_NAME.test(entry)) {
            throw new Error('Invalid RPC replay marker entry');
        }
    }

    private assertRegularOwnedMarker(stat: Stats): void {
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('Invalid RPC replay marker entry');
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('RPC replay marker has the wrong owner');
        }
    }

    private markerName(scope: string, requestId: string): string {
        return `${createHash('sha256')
            .update('idle-rpc-replay-v1\0')
            .update(scope)
            .update('\0')
            .update(requestId)
            .digest('hex')}.seen`;
    }

    private syncDirectory(): void {
        if (process.platform === 'win32') return;

        const descriptor = openSync(this.directory, constants.O_RDONLY | NO_FOLLOW);
        try {
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
    }
}
