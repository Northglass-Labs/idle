import { createHash } from 'node:crypto';
import {
    closeSync,
    constants,
    fchmodSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_MAX_ENTRIES_PER_SCOPE = 16_384;
const DIGEST = /^[a-f0-9]{64}$/;
const SCOPE_MARKER = /^[a-f0-9]{64}\.scope$/;
const REPLAY_MARKER = /^[a-f0-9]{64}\.seen$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type IncomingMessageReplayConsumptionResult =
    | 'consumed'
    | 'replay'
    | 'saturated';

interface DurableIncomingMessageReplayStoreConfig {
    directory: string;
    maxEntriesPerScope?: number;
}

/**
 * Process-independent at-most-once ledger for decrypted incoming messages.
 *
 * Names contain only domain-separated SHA-256 digests. Prompt text,
 * ciphertext, session/message identifiers, and encryption keys never reach
 * disk. Markers have no expiry because message ciphertext has no authenticated
 * expiry; capacity exhaustion rejects new work rather than evicting history.
 */
export class DurableIncomingMessageReplayStore {
    private readonly directory: string;
    private readonly initializationAnchor: string;
    private readonly maxEntriesPerScope: number;
    private readonly validatedScopes = new Set<string>();

    constructor(config: DurableIncomingMessageReplayStoreConfig) {
        if (
            !Number.isSafeInteger(
                config.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE,
            )
            || (config.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE) < 1
        ) {
            throw new Error('Invalid message replay marker capacity');
        }

        this.directory = config.directory;
        this.initializationAnchor = join(
            dirname(config.directory),
            `.${basename(config.directory)}.initialized`,
        );
        this.maxEntriesPerScope = (
            config.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE
        );
    }

    consume(
        scope: string,
        replayKey: string,
    ): IncomingMessageReplayConsumptionResult {
        this.ensureInitializedRoot();
        const scopeDigest = this.digest('scope', scope);
        const scopeDirectory = this.ensureScopeDirectory(scopeDigest);
        const markerPath = join(
            scopeDirectory,
            `${this.digest('message', replayKey)}.seen`,
        );

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
                this.assertRegularOwnedFile(markerPath, lstatSync(markerPath));
                return 'replay';
            }
            throw error;
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }

        if (this.countMarkers(scopeDirectory) > this.maxEntriesPerScope) {
            unlinkSync(markerPath);
            this.syncDirectory(scopeDirectory);
            return 'saturated';
        }

        this.syncDirectory(scopeDirectory);
        return 'consumed';
    }

    private ensureInitializedRoot(): void {
        const anchor = this.readInitializationAnchor();
        if (anchor === 'valid') {
            try {
                this.assertOwnerOnlyDirectory(this.directory, lstatSync(this.directory));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    throw new Error('Message replay marker directory is missing');
                }
                throw error;
            }
            this.assertRootEntries();
            return;
        }

        try {
            mkdirSync(this.directory, { recursive: false, mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        this.assertOwnerOnlyDirectory(this.directory, lstatSync(this.directory));
        this.assertRootEntries();
        this.createInitializationAnchor();
    }

    private readInitializationAnchor(): 'missing' | 'valid' {
        try {
            const stat = lstatSync(this.initializationAnchor);
            this.assertRegularOwnedFile(this.initializationAnchor, stat);
            if (readFileSync(this.initializationAnchor, 'utf8') !== 'v1\n') {
                throw new Error('Invalid message replay initialization anchor');
            }
            return 'valid';
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
            throw error;
        }
    }

    private createInitializationAnchor(): void {
        let descriptor: number | undefined;
        try {
            descriptor = openSync(
                this.initializationAnchor,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
                0o600,
            );
            fchmodSync(descriptor, 0o600);
            writeFileSync(descriptor, 'v1\n', 'utf8');
            fsyncSync(descriptor);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }
        if (this.readInitializationAnchor() !== 'valid') {
            throw new Error('Invalid message replay initialization anchor');
        }
        this.syncDirectory(dirname(this.directory));
    }

    private ensureScopeDirectory(scopeDigest: string): string {
        const scopeDirectory = join(this.directory, scopeDigest);
        const scopeMarker = join(this.directory, `${scopeDigest}.scope`);
        let hasMarker = false;
        try {
            this.assertRegularOwnedFile(scopeMarker, lstatSync(scopeMarker));
            hasMarker = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        if (hasMarker) {
            try {
                this.assertOwnerOnlyDirectory(scopeDirectory, lstatSync(scopeDirectory));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    throw new Error('Message replay scope directory is missing');
                }
                throw error;
            }
            this.validateScopeEntries(scopeDirectory);
            return scopeDirectory;
        }

        try {
            mkdirSync(scopeDirectory, { recursive: false, mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new Error('Invalid unanchored message replay scope');
            }
            throw error;
        }
        this.assertOwnerOnlyDirectory(scopeDirectory, lstatSync(scopeDirectory));
        this.createScopeMarker(scopeMarker);
        this.syncDirectory(this.directory);
        this.validatedScopes.add(scopeDirectory);
        return scopeDirectory;
    }

    private createScopeMarker(scopeMarker: string): void {
        let descriptor: number | undefined;
        try {
            descriptor = openSync(
                scopeMarker,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
                0o600,
            );
            fchmodSync(descriptor, 0o600);
            writeFileSync(descriptor, 'v1\n', 'utf8');
            fsyncSync(descriptor);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
            if (descriptor !== undefined) closeSync(descriptor);
        }
        this.assertRegularOwnedFile(scopeMarker, lstatSync(scopeMarker));
    }

    private assertRootEntries(): void {
        const entries = readdirSync(this.directory, { withFileTypes: true });
        const names = new Set(entries.map((entry) => entry.name));
        for (const entry of entries) {
            const path = join(this.directory, entry.name);
            const stat = lstatSync(path);
            if (DIGEST.test(entry.name)) {
                this.assertOwnerOnlyDirectory(path, stat);
                if (!names.has(`${entry.name}.scope`)) {
                    throw new Error('Invalid unanchored message replay scope');
                }
            } else if (SCOPE_MARKER.test(entry.name)) {
                this.assertRegularOwnedFile(path, stat);
                if (!names.has(entry.name.slice(0, -'.scope'.length))) {
                    throw new Error('Message replay scope directory is missing');
                }
            } else {
                throw new Error('Invalid message replay marker entry');
            }
        }
    }

    private countMarkers(scopeDirectory: string): number {
        const entries = readdirSync(scopeDirectory);
        for (const entry of entries) {
            if (!REPLAY_MARKER.test(entry)) {
                throw new Error('Invalid message replay marker entry');
            }
        }
        return entries.length;
    }

    private validateScopeEntries(scopeDirectory: string): void {
        if (this.validatedScopes.has(scopeDirectory)) return;
        for (const entry of readdirSync(scopeDirectory)) {
            if (!REPLAY_MARKER.test(entry)) {
                throw new Error('Invalid message replay marker entry');
            }
            const path = join(scopeDirectory, entry);
            this.assertRegularOwnedFile(path, lstatSync(path));
        }
        this.validatedScopes.add(scopeDirectory);
    }

    private assertOwnerOnlyDirectory(path: string, stat: Stats): void {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Invalid message replay marker directory');
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Message replay marker directory has the wrong owner');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
            throw new Error('Message replay marker directory is not owner-only');
        }
    }

    private assertRegularOwnedFile(path: string, stat: Stats): void {
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('Invalid message replay marker entry');
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Message replay marker has the wrong owner');
        }
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
            throw new Error('Message replay marker is not owner-only');
        }
    }

    private digest(domain: 'scope' | 'message', value: string): string {
        return createHash('sha256')
            .update(`idle-message-replay-v1:${domain}\0`)
            .update(value)
            .digest('hex');
    }

    private syncDirectory(directory: string): void {
        if (process.platform === 'win32') return;
        const descriptor = openSync(directory, constants.O_RDONLY | NO_FOLLOW);
        try {
            fsyncSync(descriptor);
        } finally {
            closeSync(descriptor);
        }
    }
}
