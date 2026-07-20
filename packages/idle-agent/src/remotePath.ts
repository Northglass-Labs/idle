import { posix, win32 } from 'node:path';

const MAX_REMOTE_PATH_CHARACTERS = 4 * 1024;

export type MachineHomeDirectoryLoader = () => Promise<string>;

function isRemoteAbsolutePath(value: string): boolean {
    return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function validateRemotePath(value: string): string {
    if (
        value.length === 0
        || value.length > MAX_REMOTE_PATH_CHARACTERS
        || /[\u0000-\u001f\u007f]/u.test(value)
        || !isRemoteAbsolutePath(value)
    ) {
        throw new Error('Pass an absolute remote path with --path.');
    }
    return value;
}

export async function resolveRemotePath(
    rawPath: string | undefined,
    loadMachineHome: MachineHomeDirectoryLoader,
): Promise<string> {
    const needsMachineHome = rawPath === undefined
        || rawPath === '~'
        || rawPath.startsWith('~/')
        || rawPath.startsWith('~\\');
    if (!needsMachineHome) return validateRemotePath(rawPath);

    const homeDir = validateRemotePath(await loadMachineHome());
    if (rawPath === undefined || rawPath === '~') return homeDir;

    const relativePath = rawPath.slice(2);
    const remotePath = win32.isAbsolute(homeDir) && !posix.isAbsolute(homeDir)
        ? win32
        : posix;
    return validateRemotePath(remotePath.resolve(homeDir, relativePath));
}
