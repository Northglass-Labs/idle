import {
    chmodSync,
    copyFileSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_SEED_FILE_BYTES = 5 * 1024 * 1024;

const RUNTIME_SEED_FILES = [
    'oauth_creds.json',
    'google_accounts.json',
    '.env',
    'settings.json',
    'installation_id',
    'state.json',
    'trustedFolders.json',
    'GEMINI.md',
] as const;

const SENSITIVE_SOURCE_FILES = [
    'oauth_creds.json',
    'google_accounts.json',
    '.env',
] as const;

export interface IsolatedGeminiRuntimeHome {
    path: string;
    sensitiveSourcePaths: string[];
    cleanup: () => void;
}

function expandConfiguredHome(pathValue: string): string {
    const expanded = pathValue.replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function resolveGeminiRuntimeSourceHome(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    return environment.GEMINI_CLI_HOME
        ? join(expandConfiguredHome(environment.GEMINI_CLI_HOME), '.gemini')
        : join(homedir(), '.gemini');
}

/**
 * Give a sandboxed Gemini process disposable mutable state without granting it
 * write access to the user's trusted ~/.gemini configuration. Only the small
 * set of files required at launch is copied; histories, extensions, commands,
 * caches, and executables are deliberately excluded.
 */
export function createIsolatedGeminiRuntimeHome(options: {
    sourceHome?: string;
    temporaryRoot?: string;
} = {}): IsolatedGeminiRuntimeHome {
    const sourceHome = options.sourceHome
        ? expandConfiguredHome(options.sourceHome)
        : resolveGeminiRuntimeSourceHome();
    const runtimePath = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), 'idle-gemini-runtime-'));
    chmodSync(runtimePath, 0o700);
    // Gemini CLI treats GEMINI_CLI_HOME as a replacement OS home and its core
    // storage layer appends `.gemini` to it. Keep the disposable state there.
    const runtimeStatePath = join(runtimePath, '.gemini');
    mkdirSync(runtimeStatePath, { mode: 0o700 });

    try {
        for (const fileName of RUNTIME_SEED_FILES) {
            const sourcePath = join(sourceHome, fileName);
            let sourceStat;
            try {
                sourceStat = lstatSync(sourcePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw error;
            }

            if (!sourceStat.isFile() || sourceStat.size > MAX_SEED_FILE_BYTES) {
                continue;
            }

            const destinationPath = join(runtimeStatePath, fileName);
            copyFileSync(sourcePath, destinationPath);
            chmodSync(destinationPath, 0o600);

            // The small launcher shim reads this one file directly from
            // GEMINI_CLI_HOME before the core storage layer starts.
            if (fileName === 'settings.json') {
                const launcherSettingsPath = join(runtimePath, fileName);
                copyFileSync(sourcePath, launcherSettingsPath);
                chmodSync(launcherSettingsPath, 0o600);
            }
        }
    } catch (error) {
        rmSync(runtimePath, { recursive: true, force: true });
        throw error;
    }

    let cleaned = false;
    return {
        path: runtimePath,
        sensitiveSourcePaths: SENSITIVE_SOURCE_FILES.map((fileName) => join(sourceHome, fileName)),
        cleanup: () => {
            if (cleaned) {
                return;
            }
            cleaned = true;
            rmSync(runtimePath, { recursive: true, force: true });
        },
    };
}
