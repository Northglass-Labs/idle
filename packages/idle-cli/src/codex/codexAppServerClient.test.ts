import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { SandboxConfig } from '@/persistence';

const {
    mockNodeExecFileSync,
    mockNodeSpawnSync,
    mockCrossSpawnSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
    mockLoggerDebug,
    mockCreateIsolatedCodexRuntimeHome,
    mockCodexRuntimeCleanup,
    mockCodexRuntimeClearBootstrapAuth,
} = vi.hoisted(() => ({
    mockNodeExecFileSync: vi.fn(),
    mockNodeSpawnSync: vi.fn(),
    mockCrossSpawnSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
    mockLoggerDebug: vi.fn(),
    mockCreateIsolatedCodexRuntimeHome: vi.fn(),
    mockCodexRuntimeCleanup: vi.fn(),
    mockCodexRuntimeClearBootstrapAuth: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execFileSync: mockNodeExecFileSync,
    spawnSync: mockNodeSpawnSync,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
    sync: mockCrossSpawnSync,
    default: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: mockLoggerDebug,
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./isolatedRuntimeHome', () => ({
    createIsolatedCodexRuntimeHome: mockCreateIsolatedCodexRuntimeHome,
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

function mockSyncResult({
    status = 0,
    stdout = '',
    stderr = '',
    error,
}: {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
} = {}) {
    return {
        pid: 12345,
        output: [null, stdout, stderr],
        status,
        signal: null,
        stdout,
        stderr,
        error,
    };
}

function useLoginStatusResult(result: ReturnType<typeof mockSyncResult>): void {
    mockCrossSpawnSync.mockImplementation((_command, args) => {
        if (Array.isArray(args) && args[0] === '--version') {
            return mockSyncResult({ stdout: 'codex-cli 0.144.0' });
        }
        if (Array.isArray(args) && args[0] === 'login' && args[1] === 'status') {
            return result;
        }
        return mockSyncResult();
    });
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    proc.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
        setTimeout(() => proc.emit('exit', null, signal), 0);
        return true;
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            if (msg.method === 'account/login/start' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { type: msg.params?.type } });
                }, 0);
            }
            if (msg.method === 'account/read' && msg.id != null) {
                setTimeout(() => {
                    pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            account: { type: 'chatgpt', email: null, planType: 'enterprise' },
                            requiresOpenaiAuth: true,
                        },
                    });
                }, 0);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    policyVersion: 2,
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;
    const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
    const originalCodexApiKey = process.env.CODEX_API_KEY;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        delete process.env.CODEX_ACCESS_TOKEN;
        process.env.CODEX_API_KEY = 'fixture-api-key';
        delete process.env.OPENAI_API_KEY;
        mockNodeExecFileSync.mockImplementation(() => {
            throw new Error('Node execFileSync must not run Codex commands');
        });
        mockNodeSpawnSync.mockImplementation(() => {
            throw new Error('Node spawnSync must not run Codex commands');
        });
        useLoginStatusResult(mockSyncResult({
            status: 1,
            stderr: 'Not logged in\n',
        }));
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
        mockCreateIsolatedCodexRuntimeHome.mockReturnValue({
            path: '/private/tmp/idle-codex-runtime-fixture',
            sourceHome: '/Users/test/.codex',
            clearBootstrapAuth: mockCodexRuntimeClearBootstrapAuth,
            cleanup: mockCodexRuntimeCleanup,
        });
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
        if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
        else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
        if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
        else process.env.CODEX_API_KEY = originalCodexApiKey;
        if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockCrossSpawnSync.mockReturnValueOnce(mockSyncResult({ stdout: 'codex-cli 0.140.0' }));
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockCrossSpawnSync.mockReturnValueOnce(mockSyncResult({ stdout: 'codex-cli 0.130.0' }));
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('runs Codex version probes with a dedicated credential-free environment', async () => {
        const originalEnv = { ...process.env };
        try {
            process.env.PATH = '/review/bin';
            process.env.SystemRoot = 'C:\\Windows';
            process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
            process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
            process.env.LANG = 'en_US.UTF-8';
            process.env.LC_ALL = 'en_US.UTF-8';
            process.env.LC_CTYPE = 'UTF-8';
            process.env.LC_MESSAGES = 'en_US.UTF-8';
            process.env.CODEX_ACCESS_TOKEN = 'codex-access-must-not-leak';
            process.env.CODEX_API_KEY = 'codex-api-must-not-leak';
            process.env.OPENAI_API_KEY = 'openai-must-not-leak';
            process.env.OPENAI_BASE_URL = 'https://provider-secret.example.test';
            process.env.GITHUB_TOKEN = 'github-must-not-leak';
            process.env.IDLE_AUTH_TOKEN = 'idle-must-not-leak';
            process.env.AWS_SECRET_ACCESS_KEY = 'unrelated-must-not-leak';
            process.env.NODE_OPTIONS = '--require /tmp/untrusted.cjs';
            mockCrossSpawnSync.mockReturnValueOnce(mockSyncResult({ stdout: 'codex-cli 0.144.0' }));

            const { isCodexCliAvailable } = await import('./codexAppServerClient');
            expect(isCodexCliAvailable()).toBe(true);

            expect(mockCrossSpawnSync).toHaveBeenCalledWith(
                'codex',
                ['--version'],
                expect.objectContaining({
                    encoding: 'utf8',
                    windowsHide: true,
                    env: {
                        PATH: '/review/bin',
                        SystemRoot: 'C:\\Windows',
                        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
                        PATHEXT: '.COM;.EXE;.BAT;.CMD',
                        LANG: 'en_US.UTF-8',
                        LC_ALL: 'en_US.UTF-8',
                        LC_CTYPE: 'UTF-8',
                        LC_MESSAGES: 'en_US.UTF-8',
                    },
                }),
            );
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it('uses shim-aware synchronous spawning for Windows npm Codex wrappers', async () => {
        const originalEnv = { ...process.env };
        try {
            process.env.PATH = 'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Windows\\System32';
            process.env.SystemRoot = 'C:\\Windows';
            process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
            process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
            mockCrossSpawnSync.mockReturnValueOnce(mockSyncResult({
                stdout: 'codex-cli 0.144.0',
            }));

            const { isCodexCliAvailable } = await import('./codexAppServerClient');
            expect(isCodexCliAvailable()).toBe(true);

            expect(mockCrossSpawnSync).toHaveBeenCalledWith(
                'codex',
                ['--version'],
                expect.objectContaining({
                    env: expect.objectContaining({
                        PATHEXT: '.COM;.EXE;.BAT;.CMD',
                        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
                    }),
                }),
            );
            expect(mockNodeExecFileSync).not.toHaveBeenCalled();
            expect(mockNodeSpawnSync).not.toHaveBeenCalled();
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it('wraps transport when sandbox is enabled', async () => {
        const requests: MockRpcMessage[] = [];
        mockSpawn.mockImplementationOnce(() => createMockProcess({
            onRequest: (message) => requests.push(message),
        }));
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd(), {
            additionalWritePaths: ['/private/tmp/idle-codex-runtime-fixture'],
            additionalDenyReadPaths: ['/Users/test/.codex'],
            includeDefaultAgentStatePaths: false,
        });
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    CODEX_HOME: '/private/tmp/idle-codex-runtime-fixture',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);
        expect(requests).toContainEqual(expect.objectContaining({
            method: 'account/login/start',
            params: {
                type: 'apiKey',
                apiKey: 'fixture-api-key',
            },
        }));
        expect(mockCodexRuntimeClearBootstrapAuth).toHaveBeenCalledTimes(1);

        await client.disconnect();
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
    });

    it('keeps sandboxed API keys out of the child environment and ephemeralizes login state', async () => {
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const requests: MockRpcMessage[] = [];
        try {
            process.env.CODEX_API_KEY = 'fixture-api-key';
            mockSpawn.mockImplementationOnce(() => createMockProcess({
                onRequest: (message) => requests.push(message),
            }));
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await client.connect();

            const spawnEnv = mockSpawn.mock.calls[0]?.[2]?.env;
            expect(spawnEnv).not.toHaveProperty('CODEX_API_KEY');
            expect(spawnEnv).not.toHaveProperty('OPENAI_API_KEY');
            expect(requests).toContainEqual(expect.objectContaining({
                method: 'account/login/start',
                params: { type: 'apiKey', apiKey: 'fixture-api-key' },
            }));
            expect(mockCodexRuntimeClearBootstrapAuth).toHaveBeenCalledTimes(1);
            await client.disconnect();
        } finally {
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
        }
    });

    it('bootstraps a sandboxed Codex access token without exposing it to provider or model subprocesses', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        const requests: MockRpcMessage[] = [];
        try {
            process.env.CODEX_ACCESS_TOKEN = 'fixture-access-token';
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            mockSpawn.mockImplementationOnce(() => createMockProcess({
                onRequest: (message) => requests.push(message),
            }));
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await client.connect();

            expect(mockCrossSpawnSync).toHaveBeenCalledWith(
                'codex',
                expect.arrayContaining([
                    'login',
                    '--with-access-token',
                    '-c',
                    'cli_auth_credentials_store="file"',
                ]),
                expect.objectContaining({
                    encoding: 'utf8',
                    input: 'fixture-access-token',
                    env: expect.objectContaining({
                        CODEX_HOME: '/private/tmp/idle-codex-runtime-fixture',
                    }),
                    maxBuffer: 64 * 1024,
                    stdio: ['pipe', 'ignore', 'ignore'],
                    timeout: 15_000,
                    windowsHide: true,
                }),
            );
            const bootstrapCall = mockCrossSpawnSync.mock.calls.find(
                ([, args]) => Array.isArray(args) && args[0] === 'login',
            );
            const bootstrapEnv = bootstrapCall?.[2]?.env;
            expect(bootstrapEnv).not.toHaveProperty('CODEX_ACCESS_TOKEN');
            expect(bootstrapEnv).not.toHaveProperty('CODEX_API_KEY');
            expect(bootstrapEnv).not.toHaveProperty('OPENAI_API_KEY');
            expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', [
                'app-server',
                '--listen',
                'stdio://',
                '-c',
                'cli_auth_credentials_store="file"',
            ]);

            const spawnEnv = mockSpawn.mock.calls[0]?.[2]?.env;
            expect(spawnEnv).not.toHaveProperty('CODEX_ACCESS_TOKEN');
            expect(spawnEnv).not.toHaveProperty('CODEX_API_KEY');
            expect(spawnEnv).not.toHaveProperty('OPENAI_API_KEY');
            expect(requests).toContainEqual(expect.objectContaining({
                method: 'account/read',
                params: { refreshToken: false },
            }));
            expect(JSON.stringify(requests)).not.toContain('fixture-access-token');
            expect(mockCodexRuntimeClearBootstrapAuth).toHaveBeenCalledTimes(1);

            await client.disconnect();
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('rejects oversized Codex access tokens before sandbox or provider startup', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            process.env.CODEX_ACCESS_TOKEN = 'x'.repeat(16 * 1024 + 1);
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await expect(client.connect()).rejects.toThrow('access token exceeds the supported size');
            expect(mockCrossSpawnSync.mock.calls.some(
                ([, args]) => Array.isArray(args) && args[0] === 'login',
            )).toBe(false);
            expect(mockInitializeSandbox).not.toHaveBeenCalled();
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('fails closed when Codex rejects an access token without exposing provider diagnostics', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            process.env.CODEX_ACCESS_TOKEN = 'fixture-rejected-access-token';
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            mockCrossSpawnSync.mockImplementation((_command, args) => {
                if (Array.isArray(args) && args[0] === '--version') {
                    return mockSyncResult({ stdout: 'codex-cli 0.144.0' });
                }
                return mockSyncResult({
                    status: 1,
                    stderr: 'opaque-codex-login-diagnostic-must-not-cross',
                    error: new Error('opaque-codex-login-diagnostic-must-not-cross'),
                });
            });
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            let caught: unknown;
            try {
                await client.connect();
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({
                name: 'CodexSandboxAuthenticationError',
                code: 'CODEX_SANDBOX_ACCESS_TOKEN_REJECTED',
                message: 'Codex access token bootstrap failed. Verify CODEX_ACCESS_TOKEN and try again.',
            });
            expect(String(caught)).not.toContain('opaque-codex-login-diagnostic-must-not-cross');
            expect(mockInitializeSandbox).not.toHaveBeenCalled();
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('uses the first non-empty explicit API key and rejects oversized credentials', async () => {
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        const requests: MockRpcMessage[] = [];
        try {
            process.env.CODEX_API_KEY = '   ';
            process.env.OPENAI_API_KEY = 'openai-fallback-key';
            mockSpawn.mockImplementationOnce(() => createMockProcess({
                onRequest: (message) => requests.push(message),
            }));
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await client.connect();
            expect(requests).toContainEqual(expect.objectContaining({
                method: 'account/login/start',
                params: { type: 'apiKey', apiKey: 'openai-fallback-key' },
            }));
            await client.disconnect();

            process.env.CODEX_API_KEY = 'x'.repeat(16 * 1024 + 1);
            delete process.env.OPENAI_API_KEY;
            const oversizedClient = new CodexAppServerClient(sandboxConfig);
            await expect(oversizedClient.connect()).rejects.toThrow('exceeds the supported size');
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(2);
        } finally {
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('fails fast with a typed keyring-only authentication error before sandbox startup', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            delete process.env.CODEX_ACCESS_TOKEN;
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            useLoginStatusResult(mockSyncResult({
                status: 0,
                stderr: 'Logged in using ChatGPT\n',
            }));
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await expect(client.connect()).rejects.toMatchObject({
                name: 'CodexSandboxAuthenticationError',
                code: 'CODEX_SANDBOX_KEYRING_AUTH_UNSUPPORTED',
                message: 'Codex is signed in with ChatGPT through the OS keyring, but that consumer login cannot be delegated to Idle\'s isolated sandbox. Use `idle codex --no-sandbox` explicitly, or configure CODEX_ACCESS_TOKEN (Business/Enterprise), CODEX_API_KEY, or OPENAI_API_KEY.',
            });
            expect(mockInitializeSandbox).not.toHaveBeenCalled();
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
            expect(mockCrossSpawnSync).toHaveBeenCalledWith(
                'codex',
                ['login', 'status'],
                expect.objectContaining({
                    encoding: 'utf8',
                    env: expect.objectContaining({
                        CODEX_HOME: '/Users/test/.codex',
                        CODEX_SQLITE_HOME: '/Users/test/.codex',
                    }),
                    maxBuffer: 64 * 1024,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 15_000,
                    windowsHide: true,
                }),
            );
            const statusCall = mockCrossSpawnSync.mock.calls.find(
                ([, args]) => Array.isArray(args) && args[0] === 'login' && args[1] === 'status',
            );
            expect(statusCall?.[2]?.env).not.toHaveProperty('CODEX_ACCESS_TOKEN');
            expect(statusCall?.[2]?.env).not.toHaveProperty('CODEX_API_KEY');
            expect(statusCall?.[2]?.env).not.toHaveProperty('OPENAI_API_KEY');
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('reports a distinct typed error when no supported Codex credential exists', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            delete process.env.CODEX_ACCESS_TOKEN;
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            useLoginStatusResult(mockSyncResult({
                status: 1,
                stderr: 'Not logged in\n',
            }));
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            await expect(client.connect()).rejects.toMatchObject({
                name: 'CodexSandboxAuthenticationError',
                code: 'CODEX_SANDBOX_AUTH_UNAVAILABLE',
                message: 'Sandboxed Codex requires CODEX_ACCESS_TOKEN (Business/Enterprise), CODEX_API_KEY, or OPENAI_API_KEY. To use a consumer ChatGPT login, run `codex login` and then `idle codex --no-sandbox` explicitly.',
            });
            expect(mockInitializeSandbox).not.toHaveBeenCalled();
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('redacts login-status subprocess failures behind the unavailable-auth error', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        try {
            delete process.env.CODEX_ACCESS_TOKEN;
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            mockCrossSpawnSync.mockImplementation((_command, args) => {
                if (Array.isArray(args) && args[0] === '--version') {
                    return mockSyncResult({ stdout: 'codex-cli 0.144.0' });
                }
                throw new Error('opaque-login-status-diagnostic-must-not-cross');
            });
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient(sandboxConfig);

            let caught: unknown;
            try {
                await client.connect();
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({
                name: 'CodexSandboxAuthenticationError',
                code: 'CODEX_SANDBOX_AUTH_UNAVAILABLE',
            });
            expect(String(caught)).not.toContain('opaque-login-status-diagnostic-must-not-cross');
            expect(mockInitializeSandbox).not.toHaveBeenCalled();
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('does not read or delegate file-based ChatGPT auth through internal app-server RPCs', async () => {
        const source = await readFile(new URL('./codexAppServerClient.ts', import.meta.url), 'utf8');
        const internalTokenVariant = ['chatgpt', 'AuthTokens'].join('');

        for (const forbidden of [
            ['readCodex', 'ExternalAuthTokens'].join(''),
            `type: '${internalTokenVariant}'`,
            `method === 'account/${internalTokenVariant}/refresh'`,
        ]) {
            expect(source).not.toContain(forbidden);
        }
    });

    it('uses the official Codex home and consumer login when sandboxing is explicitly disabled', async () => {
        const originalAccessToken = process.env.CODEX_ACCESS_TOKEN;
        const originalCodexApiKey = process.env.CODEX_API_KEY;
        const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
        const originalCodexHome = process.env.CODEX_HOME;
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: (message) => requests.push(message) });
        try {
            delete process.env.CODEX_ACCESS_TOKEN;
            delete process.env.CODEX_API_KEY;
            delete process.env.OPENAI_API_KEY;
            process.env.CODEX_HOME = '/Users/test/.codex';
            mockSpawn.mockReturnValueOnce(proc);
            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();

            await client.connect();

            expect(mockCreateIsolatedCodexRuntimeHome).not.toHaveBeenCalled();
            expect(mockCrossSpawnSync.mock.calls.some(
                ([, args]) => Array.isArray(args) && args[0] === 'login',
            )).toBe(false);
            expect(mockSpawn).toHaveBeenCalledWith(
                'codex',
                ['app-server', '--listen', 'stdio://'],
                expect.objectContaining({
                    env: expect.objectContaining({
                        CODEX_HOME: '/Users/test/.codex',
                    }),
                }),
            );
            expect(requests).not.toContainEqual(expect.objectContaining({
                method: 'account/login/start',
            }));

            await client.disconnect();
        } finally {
            if (originalAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
            else process.env.CODEX_ACCESS_TOKEN = originalAccessToken;
            if (originalCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
            else process.env.CODEX_API_KEY = originalCodexApiKey;
            if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
            if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = originalCodexHome;
        }
    });

    it('never persists opaque provider stderr text', async () => {
        const sentinel = 'opaque-provider-secret-never-persist';
        const proc = createMockProcess();
        mockSpawn.mockReturnValueOnce(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const callsBeforeStderr = mockLoggerDebug.mock.calls.length;
        proc.stderr.push(sentinel);
        await waitFor(() => mockLoggerDebug.mock.calls.length > callsBeforeStderr);

        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain(sentinel);
        await client.disconnect();
    });

    it('keeps provider-owned identifiers and diagnostic payloads out of persistent logs', async () => {
        const source = await readFile(new URL('./codexAppServerClient.ts', import.meta.url), 'utf8');
        for (const forbidden of [
            "Thread started:', this._threadId",
            "Thread resumed:', this._threadId",
            "Thread forked:', opts.threadId",
            'Clearing thread state: thread=${this._threadId',
            "startup status:', params",
            "server request:', err",
            "Approval handler error:', err",
            "interruptTurn error (may be expected):', err",
        ]) {
            expect(source).not.toContain(forbidden);
        }
    });

    it('fails closed when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await expect(client.connect()).rejects.toThrow('sandbox init failed');

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(client.sandboxEnabled).toBe(false);
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
    });

    it('passes only Codex-scoped and operational environment variables', async () => {
        const originalEnv = { ...process.env };
        try {
            process.env.PATH = '/usr/bin';
            process.env.HOME = '/Users/test';
            process.env.OPENAI_API_KEY = 'openai-test';
            process.env.OPENAI_BASE_URL = 'https://openai.example.test';
            process.env.CODEX_HOME = '/Users/test/.codex';
            process.env.ANTHROPIC_API_KEY = 'anthropic-must-not-leak';
            process.env.AWS_SECRET_ACCESS_KEY = 'aws-must-not-leak';
            process.env.GITHUB_TOKEN = 'github-must-not-leak';
            process.env.IDLE_AUTH_TOKEN = 'idle-must-not-leak';
            process.env.NODE_OPTIONS = '--require /tmp/untrusted.cjs';

            const { CodexAppServerClient } = await import('./codexAppServerClient');
            const client = new CodexAppServerClient();
            await client.connect();

            const spawnEnv = mockSpawn.mock.calls[0]?.[2]?.env;
            expect(spawnEnv).toMatchObject({
                PATH: '/usr/bin',
                HOME: '/Users/test',
                OPENAI_API_KEY: 'openai-test',
                OPENAI_BASE_URL: 'https://openai.example.test',
                CODEX_HOME: '/Users/test/.codex',
            });
            expect(spawnEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(spawnEnv).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
            expect(spawnEnv).not.toHaveProperty('GITHUB_TOKEN');
            expect(spawnEnv).not.toHaveProperty('IDLE_AUTH_TOKEN');
            expect(spawnEnv).not.toHaveProperty('NODE_OPTIONS');

            await client.disconnect();
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('reports a current provider crash but ignores intentional shutdown', async () => {
        const crashed = createMockProcess();
        mockSpawn.mockReturnValueOnce(crashed);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);
        const onUnexpectedExit = vi.fn();
        client.setUnexpectedExitHandler(onUnexpectedExit);

        await client.connect();
        crashed.emit('exit', 1, null);
        await waitFor(() => onUnexpectedExit.mock.calls.length === 1);

        expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
        await client.disconnect();

        const intentional = createMockProcess();
        mockSpawn.mockReturnValueOnce(intentional);
        const nextClient = new CodexAppServerClient(sandboxConfig);
        const nextHandler = vi.fn();
        nextClient.setUnexpectedExitHandler(nextHandler);
        await nextClient.connect();
        await nextClient.disconnect();
        expect(nextHandler).not.toHaveBeenCalled();
    });

    it('rejects connection promptly when the provider process emits an error', async () => {
        const proc = createMockProcess({ initializeDelayMs: 1_000 });
        mockSpawn.mockReturnValueOnce(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        const connection = client.connect();
        await new Promise((resolve) => setImmediate(resolve));
        proc.emit('error', new Error('fixture spawn failure'));

        await expect(Promise.race([
            connection,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('provider process error was not propagated promptly')),
                250,
            )),
        ])).rejects.toThrow('Codex provider process failed');
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
    });

    it('terminates a provider that exceeds the bounded JSON line transport', async () => {
        const proc = createMockProcess({ initializeDelayMs: 1_000 });
        mockSpawn.mockReturnValueOnce(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        const connection = client.connect();
        await new Promise((resolve) => setImmediate(resolve));
        proc.stdout.push(Buffer.alloc((32 * 1024 * 1024) + 1, 0x61));

        await expect(Promise.race([
            connection,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('oversized provider line was not rejected promptly')),
                500,
            )),
        ])).rejects.toThrow('Codex provider output exceeded the transport limit');
        expect(proc.kill).toHaveBeenCalled();
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
    });

    it('waits for the app-server process to exit before disconnect resolves', async () => {
        const proc = createMockProcess();
        let exited = false;
        proc.once('exit', () => {
            exited = true;
        });
        proc.kill = vi.fn((signal: NodeJS.Signals) => {
            if (signal === 'SIGTERM') {
                setTimeout(() => proc.emit('exit', 0, 'SIGTERM'), 25);
            }
            return true;
        });
        mockSpawn.mockReturnValueOnce(proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        expect(exited).toBe(true);
    });

    it('releases sandbox and runtime state even when the provider refuses termination', async () => {
        const proc = createMockProcess();
        proc.kill = vi.fn(() => true);
        mockSpawn.mockReturnValueOnce(proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        vi.useFakeTimers();
        try {
            const disconnect = client.disconnect();
            const rejected = expect(disconnect).rejects.toThrow('did not exit after SIGKILL');
            await vi.advanceTimersByTimeAsync(3_100);
            await rejected;
        } finally {
            vi.useRealTimers();
        }

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(mockCodexRuntimeCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }

            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever', { turnTimeoutMs: 5000 });
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('starts disposable test threads ephemerally and can delete a persisted test thread', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2701,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-test-cleanup', path: '/tmp/thread-test-cleanup' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/delete' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, { id: msg.id, result: {} }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            ephemeral: true,
        });

        expect(requests.find((msg) => msg.method === 'thread/start')?.params).toEqual(
            expect.objectContaining({ ephemeral: true }),
        );

        await client.deleteThread({ threadId: 'thread-test-cleanup' });

        expect(requests.find((msg) => msg.method === 'thread/delete')?.params).toEqual({
            threadId: 'thread-test-cleanup',
        });
        expect(client.threadId).toBeNull();
        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-images', turns: [] } },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/idle-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/idle-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: { thread: { id: 'thread-text', turns: [] } },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });

    it('surfaces a failed raw turn without emitting successful completion', async () => {
        const proc = createMockProcess({
            pid: 2998,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-failed', path: '/tmp/thread-failed' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-failed', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-failed',
                                turn: { id: 'turn-failed', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-failed',
                                turn: {
                                    id: 'turn-failed',
                                    items: [],
                                    status: 'failed',
                                    error: {
                                        message: 'opaque provider detail',
                                        codexErrorInfo: 'usageLimitExceeded',
                                    },
                                },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('fail safely')).resolves.toEqual({ aborted: true });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            turn_id: 'turn-failed',
            status: 'failed',
            failure: { kind: 'provider-failed', code: 'usage_limit' },
        }));
        expect(events.some(event => event.type === 'task_complete')).toBe(false);
        expect(JSON.stringify(events)).not.toContain('opaque provider detail');

        await client.disconnect();
    });

    it('retains only the safe code from a v2 provider error notification', async () => {
        const proc = createMockProcess({
            pid: 3000,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-error-notification', path: '/tmp/thread-error-notification' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-error-notification', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-error-notification',
                                turn: { id: 'turn-error-notification', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'error',
                            params: {
                                error: {
                                    message: 'provider detail must not escape',
                                    codexErrorInfo: 'usageLimitExceeded',
                                    additionalDetails: 'private provider diagnostics',
                                },
                                willRetry: false,
                                threadId: 'thread-error-notification',
                                turnId: 'turn-error-notification',
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-error-notification',
                                turn: { id: 'turn-error-notification', items: [], status: 'failed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('fail safely')).resolves.toEqual({ aborted: true });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            turn_id: 'turn-error-notification',
            status: 'failed',
            failure: { kind: 'provider-failed', code: 'usage_limit' },
        }));
        expect(JSON.stringify(events)).not.toContain('provider detail must not escape');
        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('private provider diagnostics');

        await client.disconnect();
    });

    it('classifies a usage-limit stderr marker without retaining provider text', async () => {
        let proc: ReturnType<typeof createMockProcess>;
        proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-usage-limit', path: '/tmp/thread-usage-limit' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-usage-limit', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-usage-limit',
                                turn: { id: 'turn-usage-limit', items: [], status: 'inProgress', error: null },
                            },
                        });
                        proc.stderr.push("ERROR: You've hit your usage limit. Provider detail must not persist.\n");
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-usage-limit',
                                turn: { id: 'turn-usage-limit', items: [], status: 'failed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('fail safely')).resolves.toEqual({ aborted: true });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            turn_id: 'turn-usage-limit',
            status: 'failed',
            failure: { kind: 'provider-failed', code: 'usage_limit' },
        }));
        expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('Provider detail must not persist');

        await client.disconnect();
    });

    it('does not resolve successful raw completion before the final agent item', async () => {
        let completionNotificationSent = false;
        const finalItemControl: { release?: () => void } = {};
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2999,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-late-final', path: '/tmp/thread-late-final' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-late-final', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-late-final',
                                turn: { id: 'turn-late-final', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-late-final',
                                turn: { id: 'turn-late-final', items: [], status: 'completed', error: null },
                            },
                        });
                        completionNotificationSent = true;
                        finalItemControl.release = () => pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-late-final',
                                turnId: 'turn-late-final',
                                item: {
                                    type: 'agentMessage', id: 'message-late-final', text: 'final answer', phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
        });

        let settled = false;
        const turn = client.sendTurnAndWait('complete after final item').then(result => {
            settled = true;
            return result;
        });
        await waitFor(() => completionNotificationSent);
        await waitFor(() => requests.some(request => request.method === 'thread/read')
            || events.some(event => event.type === 'task_complete'));
        expect(settled).toBe(false);

        expect(finalItemControl.release).toBeTypeOf('function');
        finalItemControl.release?.();
        await expect(turn).resolves.toEqual({ aborted: false });
        expect(events.map(event => event.type)).toEqual(expect.arrayContaining(['agent_message', 'task_complete']));
        expect(events.findIndex(event => event.type === 'agent_message'))
            .toBeLessThan(events.findIndex(event => event.type === 'task_complete'));

        await client.disconnect();
    });

    it('reconciles a final agent item from thread state before resolving raw completion', async () => {
        const proc = createMockProcess({
            pid: 3000,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: { id: 'thread-reconcile', path: '/tmp/thread-reconcile' },
                            model: 'gpt-test',
                            modelProvider: 'openai',
                            cwd: '/tmp/project',
                            approvalPolicy: 'never',
                            sandbox: { type: 'dangerFullAccess' },
                            reasoningEffort: null,
                        },
                    }), 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { turn: { id: 'turn-reconcile', items: [], status: 'inProgress', error: null } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-reconcile',
                                turn: { id: 'turn-reconcile', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-reconcile',
                                turn: { id: 'turn-reconcile', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => pushJsonLine(stdout, {
                        id: msg.id,
                        result: {
                            thread: {
                                id: 'thread-reconcile',
                                turns: [{
                                    id: 'turn-reconcile',
                                    status: 'completed',
                                    items: [{
                                        type: 'agentMessage',
                                        id: 'message-reconciled',
                                        text: 'reconciled final answer',
                                        phase: 'final_answer',
                                    }],
                                }],
                            },
                        },
                    }), 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => events.push(msg as Record<string, unknown>));

        await client.connect();
        await client.startThread({
            model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('reconcile final item')).resolves.toEqual({ aborted: false });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'agent_message', message: 'reconciled final answer', item_id: 'message-reconciled',
        }));
        expect(events.findIndex(event => event.type === 'agent_message'))
            .toBeLessThan(events.findIndex(event => event.type === 'task_complete'));

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'call-1', output: '/tmp/project\n' }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'patch-approval-1',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('falls back to final answer completion when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('say hi')).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'idle',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the idle MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'idle:77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'idle',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });
});
