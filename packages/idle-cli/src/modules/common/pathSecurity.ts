import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PathValidationResult {
    valid: boolean;
    resolvedPath?: string;
    exists?: boolean;
    error?: string;
}

export interface OpenedWorkspacePath {
    handle: FileHandle;
    resolvedPath: string;
    assertStillSafe: () => Promise<void>;
}

export type OpenedWorkspacePathType = 'file' | 'directory' | 'any';

const NO_FOLLOW = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function isContainedPath(targetPath: string, rootPath: string): boolean {
    const relativePath = relative(rootPath, targetPath);
    return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function denied(targetPath: string, reason: string): PathValidationResult {
    return {
        valid: false,
        error: `Access denied: Path '${targetPath}' ${reason}`,
    };
}

function pathAccessError(targetPath: string, reason: string): Error {
    return new Error(`Access denied: Path '${targetPath}' ${reason}`);
}

async function assertDescriptorIsContained(
    handle: FileHandle,
    resolvedPath: string,
    canonicalRoot: string,
    targetPath: string,
    expectedType: OpenedWorkspacePathType,
): Promise<void> {
    // Resolve after open, then bind that canonical result back to the opened
    // descriptor. Stable and one-way intermediate swaps either resolve outside
    // the workspace or identify a different inode than the descriptor used for
    // I/O. Node does not expose openat2/F_GETPATH portably, so callers also keep
    // the descriptor and repeat this fail-closed check before returning data.
    const canonicalTarget = await realpath(resolvedPath);
    if (!isContainedPath(canonicalTarget, canonicalRoot)) {
        throw pathAccessError(targetPath, 'resolves outside the working directory after open');
    }

    const [openedStats, canonicalStats] = await Promise.all([
        handle.stat(),
        lstat(canonicalTarget),
    ]);
    if (canonicalStats.isSymbolicLink() || openedStats.dev !== canonicalStats.dev || openedStats.ino !== canonicalStats.ino) {
        throw pathAccessError(targetPath, 'changed during secure open');
    }
    if (expectedType === 'file' && !openedStats.isFile()) {
        throw pathAccessError(targetPath, 'is not a regular file');
    }
    if (expectedType === 'directory' && !openedStats.isDirectory()) {
        throw pathAccessError(targetPath, 'is not a directory');
    }
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // Uses path.sep to work correctly on both Windows (\) and Unix (/)
    if (!resolvedTarget.startsWith(resolvedWorkingDir + sep) && resolvedTarget !== resolvedWorkingDir) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}

/**
 * Resolve an existing path without accepting any symlinked path component.
 * The workspace root itself is canonicalized because it is trusted session
 * configuration; every caller-controlled component below it must be real.
 */
export async function validateExistingPath(
    targetPath: string,
    workingDirectory: string,
): Promise<PathValidationResult> {
    try {
        const canonicalRoot = await realpath(resolve(workingDirectory));
        return validateExistingPathAgainstRoot(targetPath, workingDirectory, canonicalRoot);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'working directory could not be resolved';
        return denied(targetPath, `could not be resolved (${message})`);
    }
}

async function validateExistingPathAgainstRoot(
    targetPath: string,
    workingDirectory: string,
    canonicalRoot: string,
): Promise<PathValidationResult> {
    const lexical = validatePath(targetPath, workingDirectory);
    if (!lexical.valid || !lexical.resolvedPath) {
        return lexical;
    }

    try {
        const lexicalRoot = resolve(workingDirectory);
        const relativeTarget = relative(lexicalRoot, lexical.resolvedPath);
        let currentPath = canonicalRoot;

        for (const component of relativeTarget.split(sep).filter(Boolean)) {
            currentPath = join(currentPath, component);
            const stats = await lstat(currentPath);
            if (stats.isSymbolicLink()) {
                return denied(targetPath, 'contains a symbolic link');
            }
        }

        const canonicalTarget = await realpath(currentPath);
        if (!isContainedPath(canonicalTarget, canonicalRoot)) {
            return denied(targetPath, 'resolves outside the working directory');
        }

        return { valid: true, resolvedPath: canonicalTarget, exists: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'path could not be resolved';
        return denied(targetPath, `could not be resolved (${message})`);
    }
}

/**
 * Open an existing workspace path and bind validation to the returned file
 * descriptor. Callers must perform I/O through `handle`, not the pathname.
 * `assertStillSafe` is available for a final fail-closed check before a result
 * is returned or before destructive work starts.
 */
export async function openExistingWorkspacePath(
    targetPath: string,
    workingDirectory: string,
    flags: number = constants.O_RDONLY,
    expectedType: OpenedWorkspacePathType = 'any',
): Promise<OpenedWorkspacePath> {
    // Capture the trusted root once. Recomputing it after target validation
    // would let a replaced workspace-root symlink redefine the containment
    // boundary to the attacker's directory.
    const canonicalRoot = await realpath(resolve(workingDirectory));
    const validation = await validateExistingPathAgainstRoot(targetPath, workingDirectory, canonicalRoot);
    if (!validation.valid || !validation.resolvedPath) {
        throw new Error(validation.error ?? `Access denied: Path '${targetPath}' is unsafe`);
    }

    const handle = await open(validation.resolvedPath, flags | NO_FOLLOW);
    const assertStillSafe = async (): Promise<void> => {
        await assertDescriptorIsContained(
            handle,
            validation.resolvedPath!,
            canonicalRoot,
            targetPath,
            expectedType,
        );
    };

    try {
        await assertStillSafe();
        return {
            handle,
            resolvedPath: validation.resolvedPath,
            assertStillSafe,
        };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
