import {
    chmodSync,
    lstatSync,
    mkdtempSync,
    realpathSync,
    readdirSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RUNTIME_PREFIX = 'idle-codex-runtime-';

export interface IsolatedCodexRuntimeHome {
    path: string;
    sourceHome: string;
    clearBootstrapAuth: () => void;
    cleanup: () => void;
}

function expandConfiguredHome(pathValue: string): string {
    const expanded = pathValue.replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function canonicalizeSourceHome(pathValue: string): string {
    try {
        return realpathSync(pathValue);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return pathValue;
        throw error;
    }
}

export function resolveCodexRuntimeSourceHome(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return environment.CODEX_HOME
        ? expandConfiguredHome(environment.CODEX_HOME)
        : join(homedir(), '.codex');
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function removeDeadProcessRuntimeHomes(temporaryRoot: string): void {
    if (typeof process.getuid !== 'function') return;
    const currentUid = process.getuid();

    let entries;
    try {
        entries = readdirSync(temporaryRoot, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^idle-codex-runtime-(\d+)-/);
        if (!match) continue;
        const ownerPid = Number(match[1]);
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || processIsAlive(ownerPid)) continue;

        const candidate = join(temporaryRoot, entry.name);
        try {
            const stat = lstatSync(candidate);
            if (!stat.isDirectory() || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) continue;
            rmSync(candidate, { recursive: true, force: true });
        } catch {
            // A concurrent process may already have removed the stale directory.
        }
    }
}

/**
 * Give a sandboxed Codex process disposable mutable state without exposing the
 * user's trusted config, hooks, skills, transcripts, databases, or credential
 * files. Explicit credentials are bootstrapped only into this disposable home
 * and removed before model-controlled work starts.
 */
export function createIsolatedCodexRuntimeHome(options: {
    sourceHome?: string;
    temporaryRoot?: string;
} = {}): IsolatedCodexRuntimeHome {
    const configuredSourceHome = options.sourceHome
        ? expandConfiguredHome(options.sourceHome)
        : resolveCodexRuntimeSourceHome();
    const sourceHome = canonicalizeSourceHome(configuredSourceHome);
    const temporaryRoot = options.temporaryRoot ?? tmpdir();
    removeDeadProcessRuntimeHomes(temporaryRoot);
    const runtimePath = mkdtempSync(join(temporaryRoot, `${RUNTIME_PREFIX}${process.pid}-`));
    chmodSync(runtimePath, 0o700);

    let cleaned = false;
    return {
        path: runtimePath,
        sourceHome,
        clearBootstrapAuth: () => {
            try {
                unlinkSync(join(runtimePath, 'auth.json'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        },
        cleanup: () => {
            if (cleaned) return;
            cleaned = true;
            rmSync(runtimePath, { recursive: true, force: true });
        },
    };
}
