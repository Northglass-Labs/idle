import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import {
    DEFAULT_SANDBOX_DENY_READ_PATHS,
    IDLE_SENSITIVE_FILE_NAMES,
} from '@/security/idleSensitivePaths';

type IdleSandboxRuntimeConfig = Omit<SandboxRuntimeConfig, 'network'> & {
    network: Omit<SandboxRuntimeConfig['network'], 'allowedDomains'> & {
        // The runtime treats omission as explicit unrestricted networking.
        // Its published type currently requires the field despite supporting
        // the omitted form internally.
        allowedDomains?: string[];
    };
};

export interface SandboxRuntimeOverrides {
    additionalWritePaths?: string[];
    additionalDenyReadPaths?: string[];
    includeDefaultAgentStatePaths?: boolean;
}

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function appendPath(root: string, suffix: string, sessionPath: string): string {
    return resolve(expandPath(root, sessionPath), suffix);
}

/**
 * Agent runtimes need to persist transcripts and runtime databases, but granting
 * write access to all of ~/.codex or ~/.claude also lets a remote session replace
 * trusted config, hooks, plugins, skills, and credentials for future launches.
 */
function getMutableAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        ...[
            'sessions',
            'archived_sessions',
            'session_index.jsonl',
            'history.jsonl',
            'state_5.sqlite',
            'state_5.sqlite-shm',
            'state_5.sqlite-wal',
            'goals_1.sqlite',
            'goals_1.sqlite-shm',
            'goals_1.sqlite-wal',
            'memories_1.sqlite',
            'memories_1.sqlite-shm',
            'memories_1.sqlite-wal',
            'logs_2.sqlite',
            'logs_2.sqlite-shm',
            'logs_2.sqlite-wal',
            'log',
            'shell_snapshots',
            'tmp',
            '.tmp',
            'process_manager',
            'mcp-oauth-locks',
            'models_cache.json',
            'version.json',
        ].map((suffix) => appendPath(codexHome, suffix, sessionPath)),
        ...[
            'projects',
            'tasks',
            'todos',
            'plans',
            'debug',
            'file-history',
            'session-env',
            'shell-snapshots',
            'history.jsonl',
            'stats-cache.json',
        ].map((suffix) => appendPath(claudeConfigDir, suffix, sessionPath)),
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    overrides: SandboxRuntimeOverrides = {},
): IdleSandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const additionalWritePaths = resolvePaths(overrides.additionalWritePaths ?? [], sessionPath);
    const mutableAgentStatePaths = overrides.includeDefaultAgentStatePaths === false
        ? []
        : getMutableAgentStatePaths(sessionPath);

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([
                    resolve(sessionPath),
                    ...extraWritePaths,
                    ...additionalWritePaths,
                    ...mutableAgentStatePaths,
                ]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([
                    workspaceRoot,
                    resolve(sessionPath),
                    ...extraWritePaths,
                    ...additionalWritePaths,
                    ...mutableAgentStatePaths,
                ]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...additionalWritePaths,
                    ...mutableAgentStatePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;
    const idleSensitivePaths = IDLE_SENSITIVE_FILE_NAMES.map(
        (fileName) => join(configuration.idleHomeDir, fileName),
    );
    const idleDiagnosticPaths = [configuration.logsDir];

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead: uniquePaths([
                ...resolvePaths([...DEFAULT_SANDBOX_DENY_READ_PATHS], sessionPath),
                ...resolvePaths(sandboxConfig.denyReadPaths, sessionPath),
                ...resolvePaths(overrides.additionalDenyReadPaths ?? [], sessionPath),
                ...idleSensitivePaths,
                ...idleDiagnosticPaths,
            ]),
            allowWrite,
            denyWrite: uniquePaths([
                ...resolvePaths(sandboxConfig.denyWritePaths, sessionPath),
                ...idleSensitivePaths,
                ...idleDiagnosticPaths,
            ]),
        },
    };
}
