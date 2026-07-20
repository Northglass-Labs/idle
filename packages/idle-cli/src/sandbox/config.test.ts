import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxRuntimeConfig } from './config';
import type { SandboxConfig } from '@/persistence';
import { SandboxConfigSchema } from '@/persistence';
import { configuration } from '@/configuration';

const sessionPath = '/tmp/idle-session';

function resolveLikeRuntime(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }
    return resolve(sessionPath, expandedHome);
}

function expectedMutableAgentStatePaths(): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    return [
        ...[
            'sessions', 'archived_sessions', 'session_index.jsonl', 'history.jsonl',
            'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal',
            'goals_1.sqlite', 'goals_1.sqlite-shm', 'goals_1.sqlite-wal',
            'memories_1.sqlite', 'memories_1.sqlite-shm', 'memories_1.sqlite-wal',
            'logs_2.sqlite', 'logs_2.sqlite-shm', 'logs_2.sqlite-wal', 'log',
            'shell_snapshots', 'tmp', '.tmp', 'process_manager', 'mcp-oauth-locks',
            'models_cache.json', 'version.json',
        ].map((suffix) => resolve(resolveLikeRuntime(codexHome), suffix)),
        ...[
            'projects', 'tasks', 'todos', 'plans', 'debug', 'file-history',
            'session-env', 'shell-snapshots', 'history.jsonl', 'stats-cache.json',
        ].map((suffix) => resolve(resolveLikeRuntime(claudeConfigDir), suffix)),
    ];
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return SandboxConfigSchema.parse({
        policyVersion: 2,
        enabled: true,
        workspaceRoot: '~/projects',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    });
}

describe('buildSandboxRuntimeConfig', () => {
    it('always denies agent reads of Idle credentials, control capability, and session keys', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ denyReadPaths: [] }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.denyRead).toEqual(expect.arrayContaining([
            `${homedir()}/.config/gh`,
            `${homedir()}/.config/gcloud`,
            `${homedir()}/Library/Application Support/Google/Chrome`,
            configuration.logsDir,
            join(configuration.idleHomeDir, 'access.key'),
            join(configuration.idleHomeDir, 'agent.key'),
            join(configuration.idleHomeDir, 'settings.json'),
            join(configuration.idleHomeDir, 'settings.json.lock'),
            join(configuration.idleHomeDir, 'daemon.state.json'),
            join(configuration.idleHomeDir, 'daemon.state.json.lock'),
            join(configuration.idleHomeDir, 'sessions.json'),
            join(configuration.idleHomeDir, 'rpc-replay-v1'),
            join(configuration.idleHomeDir, 'message-replay-v1'),
            join(configuration.idleHomeDir, '.message-replay-v1.initialized'),
        ]));
        expect(runtimeConfig.filesystem?.denyWrite).toEqual(expect.arrayContaining([
            configuration.logsDir,
            join(configuration.idleHomeDir, 'access.key'),
            join(configuration.idleHomeDir, 'agent.key'),
            join(configuration.idleHomeDir, 'settings.json'),
            join(configuration.idleHomeDir, 'settings.json.lock'),
            join(configuration.idleHomeDir, 'daemon.state.json'),
            join(configuration.idleHomeDir, 'daemon.state.json.lock'),
            join(configuration.idleHomeDir, 'sessions.json'),
            join(configuration.idleHomeDir, 'rpc-replay-v1'),
            join(configuration.idleHomeDir, 'message-replay-v1'),
            join(configuration.idleHomeDir, '.message-replay-v1.initialized'),
        ]));
    });

    it('maps automatic defaults to provider-only networking with local binding disabled', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            SandboxConfigSchema.parse({}),
            sessionPath,
        );

        expect(runtimeConfig.network.allowedDomains).toEqual(expect.arrayContaining([
            'api.anthropic.com',
            'api.openai.com',
            'generativelanguage.googleapis.com',
        ]));
        expect(runtimeConfig.network.allowLocalBinding).toBe(false);
        expect(runtimeConfig.enableWeakerNetworkIsolation).toBeUndefined();
    });

    it('builds strict filesystem isolation', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'strict' }),
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedMutableAgentStatePaths(),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const withWorkspaceRoot = buildSandboxRuntimeConfig(createConfig(), sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            '/tmp',
            ...expectedMutableAgentStatePaths(),
        ]);

        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            createConfig({ workspaceRoot: undefined }),
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedMutableAgentStatePaths(),
        ]);
    });

    it('builds custom isolation from explicit custom paths', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/sandbox', 'relative/write'],
                extraWritePaths: ['/tmp', '../scratch'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/sandbox`,
            resolve(sessionPath, 'relative/write'),
            '/tmp',
            resolve(sessionPath, '../scratch'),
            ...expectedMutableAgentStatePaths(),
        ]);
    });

    it('maps blocked and allowed network modes', () => {
        const blocked = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'blocked', allowLocalBinding: false }),
            sessionPath,
        );
        expect(blocked.network?.allowedDomains).toEqual([]);
        expect(blocked.network?.deniedDomains).toEqual([]);
        expect(blocked.network?.allowLocalBinding).toBe(false);
        expect(blocked.enableWeakerNetworkIsolation).toBeUndefined();

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed' }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toBeUndefined();
        expect(allowed.network?.deniedDomains).toEqual([]);
        expect(allowed.enableWeakerNetworkIsolation).toBe(true);
    });

    it('maps custom network mode from user lists', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                networkMode: 'custom',
                allowedDomains: ['*.github.com', 'api.openai.com'],
                deniedDomains: ['tracking.example.com'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.network?.allowedDomains).toEqual(['*.github.com', 'api.openai.com']);
        expect(runtimeConfig.network?.deniedDomains).toEqual(['tracking.example.com']);
    });

    it('resolves tilde and relative paths across all filesystem path fields', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/custom', 'relative/custom'],
                extraWritePaths: ['~/extra', './extra'],
                denyReadPaths: ['~/.ssh', 'relative/read'],
                denyWritePaths: ['.env', 'relative/write-deny'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/custom`,
            resolve(sessionPath, 'relative/custom'),
            `${homedir()}/extra`,
            resolve(sessionPath, './extra'),
            ...expectedMutableAgentStatePaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual(expect.arrayContaining([
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
            join(configuration.idleHomeDir, 'access.key'),
            join(configuration.idleHomeDir, 'agent.key'),
            join(configuration.idleHomeDir, 'settings.json'),
            join(configuration.idleHomeDir, 'settings.json.lock'),
            join(configuration.idleHomeDir, 'daemon.state.json'),
            join(configuration.idleHomeDir, 'daemon.state.json.lock'),
            join(configuration.idleHomeDir, 'sessions.json'),
            configuration.logsDir,
        ]));
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '.env'),
            resolve(sessionPath, 'relative/write-deny'),
            join(configuration.idleHomeDir, 'access.key'),
            join(configuration.idleHomeDir, 'agent.key'),
            join(configuration.idleHomeDir, 'settings.json'),
            join(configuration.idleHomeDir, 'settings.json.lock'),
            join(configuration.idleHomeDir, 'daemon.state.json'),
            join(configuration.idleHomeDir, 'daemon.state.json.lock'),
            join(configuration.idleHomeDir, 'sessions.json'),
            join(configuration.idleHomeDir, 'rpc-replay-v1'),
            join(configuration.idleHomeDir, 'message-replay-v1'),
            join(configuration.idleHomeDir, '.message-replay-v1.initialized'),
            configuration.logsDir,
        ]);
    });

    it('allows only mutable state below overridden agent homes', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '~/custom-codex-home';
            process.env.CLAUDE_CONFIG_DIR = './custom-claude-config';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath);

            expect(runtimeConfig.filesystem?.allowWrite).toContain(`${homedir()}/custom-codex-home/sessions`);
            expect(runtimeConfig.filesystem?.allowWrite).toContain(resolve(sessionPath, './custom-claude-config/projects'));
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(`${homedir()}/custom-codex-home`);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(resolve(sessionPath, './custom-claude-config'));
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(`${homedir()}/custom-codex-home/config.toml`);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(resolve(sessionPath, './custom-claude-config/settings.json'));
        } finally {
            if (originalCodexHome === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = originalCodexHome;
            }

            if (originalClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
            }
        }
    });

    it('supports an isolated provider runtime without writable trusted agent homes', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '/Users/test/.codex';
            process.env.CLAUDE_CONFIG_DIR = '/Users/test/.claude';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath, {
                additionalWritePaths: ['/private/tmp/idle-codex-runtime-fixture'],
                additionalDenyReadPaths: ['/Users/test/.codex'],
                includeDefaultAgentStatePaths: false,
            });

            expect(runtimeConfig.filesystem?.allowWrite).toContain('/private/tmp/idle-codex-runtime-fixture');
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/Users/test/.codex/sessions');
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/Users/test/.claude/projects');
            expect(runtimeConfig.filesystem?.denyRead).toContain('/Users/test/.codex');
        } finally {
            if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = originalCodexHome;
            if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
    });
});
