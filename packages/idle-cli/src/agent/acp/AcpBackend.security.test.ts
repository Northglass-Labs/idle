import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  initializeSandbox: vi.fn(),
  sandboxCleanup: vi.fn(),
  prepareSandboxedSpawn: vi.fn(),
  createIsolatedGeminiRuntimeHome: vi.fn(),
  geminiRuntimeCleanup: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  newSessionError: null as unknown,
}));

vi.mock('cross-spawn', () => ({ spawn: mocks.spawn }));

vi.mock('@/sandbox/manager', () => ({
  initializeSandbox: mocks.initializeSandbox,
  prepareSandboxedSpawn: mocks.prepareSandboxedSpawn,
}));

vi.mock('@/gemini/utils/isolatedRuntimeHome', () => ({
  createIsolatedGeminiRuntimeHome: mocks.createIsolatedGeminiRuntimeHome,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
  },
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: class MockClientSideConnection {
    async initialize() {
      return {};
    }

    async newSession() {
      if (mocks.newSessionError) {
        throw mocks.newSessionError;
      }
      return { sessionId: 'provider-session-1' };
    }

    async cancel() {}
  },
}));

import { AcpBackend } from './AcpBackend';

const sandboxConfig: SandboxConfig = {
  policyVersion: 2,
  enabled: true,
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

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  });
  return child;
}

describe('AcpBackend sandbox launch boundary', () => {
  const originalSensitiveEnvironment = {
    IDLE_ADMIN_SECRET: process.env.IDLE_ADMIN_SECRET,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IDLE_ADMIN_SECRET = 'must-not-reach-agent';
    process.env.GITHUB_TOKEN = 'unrelated-host-secret';
    mocks.initializeSandbox.mockResolvedValue(mocks.sandboxCleanup);
    mocks.prepareSandboxedSpawn.mockResolvedValue(
      (command: string, args: string[]) => ({
        command: 'sh',
        args: ['-c', 'sandbox-template "$0" "$@"', command, ...args],
      }),
    );
    mocks.createIsolatedGeminiRuntimeHome.mockReturnValue({
      path: '/tmp/idle-gemini-runtime',
      sensitiveSourcePaths: ['/Users/example/.gemini/oauth_creds.json'],
      cleanup: mocks.geminiRuntimeCleanup,
    });
    mocks.newSessionError = null;
    mocks.spawn.mockReturnValue(createChildProcess());
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalSensitiveEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('wraps Gemini/ACP before spawn and filters unrelated host secrets', async () => {
    const onSandboxApplied = vi.fn();
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: '/tmp/idle-acp-workspace',
      command: 'gemini',
      args: ['--experimental-acp', '$(not-shell-code)'],
      env: { GEMINI_API_KEY: 'provider-secret' },
      sandboxConfig,
      onSandboxApplied,
    });

    await backend.startSession();

    expect(mocks.createIsolatedGeminiRuntimeHome).toHaveBeenCalledOnce();
    expect(mocks.initializeSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        extraWritePaths: expect.arrayContaining(['/tmp/idle-gemini-runtime']),
        denyReadPaths: expect.arrayContaining(['/Users/example/.gemini/oauth_creds.json']),
      }),
      '/tmp/idle-acp-workspace',
    );
    expect(mocks.prepareSandboxedSpawn).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        'sandbox-template "$0" "$@"',
        'gemini',
        '--experimental-acp',
        '$(not-shell-code)',
      ],
      expect.objectContaining({
        cwd: '/tmp/idle-acp-workspace',
        env: expect.objectContaining({
          GEMINI_API_KEY: 'provider-secret',
          GEMINI_CLI_HOME: '/tmp/idle-gemini-runtime',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    const spawnEnvironment = mocks.spawn.mock.calls[0][2].env;
    expect(spawnEnvironment).not.toHaveProperty('IDLE_ADMIN_SECRET');
    expect(spawnEnvironment).not.toHaveProperty('GITHUB_TOKEN');
    expect(onSandboxApplied).toHaveBeenCalledWith(true);

    await backend.dispose();
    expect(mocks.sandboxCleanup).toHaveBeenCalledOnce();
    expect(mocks.geminiRuntimeCleanup).toHaveBeenCalledOnce();
    expect(onSandboxApplied).toHaveBeenLastCalledWith(false);
  });

  it('fails closed before spawn when required sandbox initialization fails', async () => {
    mocks.initializeSandbox.mockRejectedValueOnce(new Error('sandbox unavailable'));
    const onSandboxApplied = vi.fn();
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: '/tmp/idle-acp-workspace',
      command: 'gemini',
      sandboxConfig,
      onSandboxApplied,
    });

    await expect(backend.startSession()).rejects.toThrow(/sandbox initialization failed/i);

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.geminiRuntimeCleanup).toHaveBeenCalledOnce();
    expect(onSandboxApplied).toHaveBeenCalledWith(false);
  });

  it('clears observed sandbox metadata even when runtime cleanup reports an error', async () => {
    const onSandboxApplied = vi.fn();
    const backend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
      sandboxConfig,
      onSandboxApplied,
    });

    await backend.startSession();
    mocks.sandboxCleanup.mockRejectedValueOnce(new Error('cleanup failed'));
    await backend.dispose();

    expect(onSandboxApplied).toHaveBeenNthCalledWith(1, true);
    expect(onSandboxApplied).toHaveBeenLastCalledWith(false);
  });

  it('preserves structured provider error messages at the launch boundary', async () => {
    mocks.newSessionError = {
      code: 'EACCES',
      message: 'provider rejected the session',
    };
    const backend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
      sandboxConfig,
    });

    await expect(backend.startSession()).rejects.toThrow('provider rejected the session');
  });

  it('never persists opaque provider stderr or startup-error text', async () => {
    const sentinel = 'opaque-provider-secret-never-persist';
    const child = createChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const backend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
      sandboxConfig,
    });

    await backend.startSession();
    child.stderr.write(sentinel);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await backend.dispose();

    mocks.newSessionError = { message: sentinel };
    mocks.spawn.mockReturnValueOnce(createChildProcess());
    const failingBackend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
      sandboxConfig,
    });
    await expect(failingBackend.startSession()).rejects.toThrow(sentinel);

    expect(JSON.stringify([
      ...mocks.loggerDebug.mock.calls,
      ...mocks.loggerWarn.mock.calls,
    ])).not.toContain(sentinel);
  });

  it('keeps raw provider payloads and identifiers out of persistent logger calls', async () => {
    const source = await readFile(new URL('./AcpBackend.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'JSON.stringify(input)',
      'JSON.stringify(update)',
      'JSON.stringify(update, null, 2)',
      "without update field:', params",
      'toolCallId=${toolCallId}',
      'Session created:',
      'Starting session:',
      'configId,\n        value,\n        error',
      '{ modeId, error }',
      '{ modelId, error }',
      'Process exited with code ${code}, signal ${signal}',
      'Prompt contains change_title instruction',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('keeps process exit codes and signals out of persistent logger calls', async () => {
    const child = createChildProcess();
    mocks.spawn.mockReturnValueOnce(child);
    const backend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent',
    });
    await backend.startSession();

    child.emit('exit', 71, 'OPAQUE_PROVIDER_SIGNAL_9f31');

    const debugOutput = JSON.stringify(mocks.loggerDebug.mock.calls);
    expect(debugOutput).not.toContain('71');
    expect(debugOutput).not.toContain('OPAQUE_PROVIDER_SIGNAL_9f31');
    await backend.dispose();
  });

  it('never joins provider argv into a Windows command shell string', async () => {
    const source = await readFile(new URL('./AcpBackend.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("spawn('cmd.exe'");
    expect(source).not.toContain('const fullCommand = [spawnCommand, ...spawnArgs].join');
    expect(source).toContain('crossSpawn(spawnCommand, spawnArgs');
  });

  it('passes custom ACP command arguments as literal argv entries', async () => {
    const backend = new AcpBackend({
      agentName: 'custom',
      cwd: '/tmp/idle-acp-workspace',
      command: 'custom-agent.cmd',
      args: ['literal & whoami', '$(not-a-subshell)', 'quoted value'],
    });

    await backend.startSession();

    expect(mocks.spawn).toHaveBeenCalledWith(
      'custom-agent.cmd',
      ['literal & whoami', '$(not-a-subshell)', 'quoted value'],
      expect.objectContaining({
        cwd: '/tmp/idle-acp-workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
    await backend.dispose();
  });
});
