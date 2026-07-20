import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import {
    initializeSandbox,
    prepareSandboxedSpawn,
    wrapCommand,
    wrapForMcpTransport,
} from './manager';

const {
    mockInitialize,
    mockWrapWithSandbox,
    mockReset,
    mockBuildSandboxRuntimeConfig,
} = vi.hoisted(() => ({
    mockInitialize: vi.fn(),
    mockWrapWithSandbox: vi.fn(),
    mockReset: vi.fn(),
    mockBuildSandboxRuntimeConfig: vi.fn(),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
    SandboxManager: {
        initialize: mockInitialize,
        wrapWithSandbox: mockWrapWithSandbox,
        reset: mockReset,
    },
}));

vi.mock('./config', () => ({
    buildSandboxRuntimeConfig: mockBuildSandboxRuntimeConfig,
}));

describe('sandbox manager', () => {
    const runtimeConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: ['*'],
            deniedDomains: [],
            allowLocalBinding: true,
            allowUnixSockets: [],
        },
        filesystem: {
            denyRead: [],
            allowWrite: ['/tmp'],
            denyWrite: [],
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSandboxRuntimeConfig.mockReturnValue(runtimeConfig);
        mockWrapWithSandbox.mockResolvedValue('sandbox wrapped command');
    });

    it('initializes sandbox for allowed network mode and returns cleanup function', async () => {
        const sandboxConfig: SandboxConfig = {
            policyVersion: 2,
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        };

        const cleanup = await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(sandboxConfig, '/workspace/session');
        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);

        await cleanup();
        expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('initializes sandbox runtime for blocked network mode', async () => {
        const sandboxConfig: SandboxConfig = {
            policyVersion: 2,
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'blocked',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
        };

        await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);
    });

    it('forwards per-process filesystem isolation overrides', async () => {
        const sandboxConfig: SandboxConfig = {
            policyVersion: 2,
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: [],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
        };
        const overrides = {
            additionalWritePaths: ['/private/tmp/idle-codex-runtime-fixture'],
            additionalDenyReadPaths: ['/Users/test/.codex'],
            includeDefaultAgentStatePaths: false,
        };

        await initializeSandbox(sandboxConfig, '/workspace/session', overrides);

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(
            sandboxConfig,
            '/workspace/session',
            overrides,
        );
    });

    it('wrapCommand delegates to SandboxManager.wrapWithSandbox', async () => {
        const wrapped = await wrapCommand('node script.js');

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('node script.js');
        expect(wrapped).toBe('sandbox wrapped command');
    });

    it('wrapForMcpTransport keeps the Codex command and argv positional', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox-template');

        const wrapped = await wrapForMcpTransport('codex', ['mcp-server']);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('exec "$0" "$@"');
        expect(wrapped).toEqual({
            command: 'sh',
            args: ['-c', 'sandbox-template "$0" "$@"', 'codex', 'mcp-server'],
        });
    });

    it('keeps provider commands and arguments out of the generated shell program', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox-template');

        const wrapSpawn = await prepareSandboxedSpawn();
        const wrapped = wrapSpawn('/opt/Agent Tool/bin/agent', [
            '--flag',
            '$(touch /tmp/idle-sandbox-escape)',
            "quote'and space",
        ]);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('exec "$0" "$@"');
        expect(wrapped).toEqual({
            command: 'sh',
            args: [
                '-c',
                'sandbox-template "$0" "$@"',
                '/opt/Agent Tool/bin/agent',
                '--flag',
                '$(touch /tmp/idle-sandbox-escape)',
                "quote'and space",
            ],
        });
        expect(wrapped.args[1]).not.toContain('touch /tmp/idle-sandbox-escape');
    });

});
