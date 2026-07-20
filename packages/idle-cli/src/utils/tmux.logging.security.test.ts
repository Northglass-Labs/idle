import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: mocks.spawn };
});
vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.loggerDebug, warn: mocks.loggerWarn },
}));

import { TmuxUtilities } from './tmux';

function result(returncode = 0, stdout = '', stderr = '') {
  return { returncode, stdout, stderr, command: [] as string[] };
}

function renderedDiagnostics(): string {
  return [...mocks.loggerDebug.mock.calls, ...mocks.loggerWarn.mock.calls]
    .flat()
    .map((value) => {
      if (value instanceof Error) return value.message;
      if (typeof value === 'string') return value;
      return JSON.stringify(value);
    })
    .join('\n');
}

function failingChild(error: Error) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit('error', error));
  return child;
}

describe('tmux diagnostic privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves exact tmux launch behavior without logging argv, cwd, environment names, or identifiers', async () => {
    const session = 'private-session-identity-sentinel';
    const window = 'private-window-identity-sentinel';
    const providerId = 'private-provider-thread-sentinel';
    const cwd = '/Users/private-person/private-cwd-sentinel';
    const invalidEnvironmentName = 'PRIVATE_EMPLOYER_KEY_SENTINEL!';
    const panePid = 49281;
    const utils = new TmuxUtilities(session);
    const execute = vi.spyOn(utils, 'executeTmuxCommand').mockImplementation(async (cmd) => {
      if (cmd[0] === 'new-window') return result(0, String(panePid));
      return result();
    });

    const response = await utils.spawnInTmux(
      [`idle codex --resume ${providerId}`],
      { sessionName: session, windowName: window, cwd },
      {
        SAFE_KEY: 'opaque-environment-value-sentinel',
        [invalidEnvironmentName]: 'ignored-value',
      },
    );

    expect(response).toEqual({
      success: true,
      sessionId: `${session}:${window}`,
      pid: panePid,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.arrayContaining([
        'new-window',
        '-n',
        window,
        '-c',
        cwd,
        `idle codex --resume ${providerId}`,
      ]),
      session,
    );

    const diagnostics = renderedDiagnostics();
    for (const forbidden of [
      session,
      window,
      providerId,
      cwd,
      invalidEnvironmentName,
      String(panePid),
      'opaque-environment-value-sentinel',
    ]) {
      expect(diagnostics).not.toContain(forbidden);
    }
  });

  it('does not pass raw subprocess exceptions into the logger', async () => {
    const sentinel = 'opaque-tmux-subprocess-error-sentinel';
    const error = new Error(sentinel);
    mocks.spawn.mockReturnValueOnce(failingChild(error));
    const utils = new TmuxUtilities();

    await expect(utils.executeTmuxCommand(['list-sessions'])).resolves.toBeNull();

    expect(renderedDiagnostics()).not.toContain(sentinel);
    expect(mocks.loggerDebug.mock.calls.flat()).not.toContain(error);
  });

  it('decodes a file URL working directory before passing it to tmux', async () => {
    const cwd = '/tmp/idle workspace';
    const utils = new TmuxUtilities('safe-session');
    const execute = vi.spyOn(utils, 'executeTmuxCommand').mockImplementation(async (cmd) => {
      if (cmd[0] === 'new-window') return result(0, '49281');
      return result();
    });

    await expect(utils.spawnInTmux(
      ['idle codex'],
      { sessionName: 'safe-session', windowName: 'safe-window', cwd: pathToFileURL(cwd) },
    )).resolves.toMatchObject({ success: true });
    expect(execute).toHaveBeenCalledWith(
      expect.arrayContaining(['-c', cwd]),
      'safe-session',
    );
  });

  it('returns and logs a stable spawn category instead of raw tmux output', async () => {
    const sentinel = 'opaque-tmux-stderr-private-sentinel';
    const utils = new TmuxUtilities('safe-session');
    vi.spyOn(utils, 'executeTmuxCommand').mockImplementation(async (cmd) => {
      if (cmd[0] === 'new-window') return result(1, '', sentinel);
      return result();
    });

    const response = await utils.spawnInTmux(['idle claude']);

    expect(response).toEqual({ success: false, error: 'Failed to create tmux window' });
    expect(renderedDiagnostics()).not.toContain(sentinel);
  });

  it('does not echo malformed pane output through the alternate spawn-failure branch', async () => {
    const sentinel = 'opaque-invalid-pane-output-private-sentinel';
    const utils = new TmuxUtilities('safe-session');
    vi.spyOn(utils, 'executeTmuxCommand').mockImplementation(async (cmd) => {
      if (cmd[0] === 'new-window') return result(0, sentinel);
      return result();
    });

    const response = await utils.spawnInTmux(['idle claude']);

    expect(response).toEqual({
      success: false,
      error: 'tmux did not return a valid pane process ID',
    });
    expect(renderedDiagnostics()).not.toContain(sentinel);
  });

  it('keeps malformed session/window values and raw errors out of every tmux logger call', async () => {
    const source = await readFile(new URL('./tmux.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      "Failed to parse TMUX environment variable:', error",
      "Command execution failed:', error",
      'Unknown operation: ${operation}',
      'Using first existing session: ${sessionName}',
      'No existing sessions, using default: ${sessionName}',
      'Skipping undefined/null environment variable: ${key}',
      'Skipping invalid environment variable name: ${key}',
      'tmux session ${sessionName}, window ${windowName}, PID ${panePid}',
      "Failed to spawn in tmux:', error",
      'Invalid session identifier: ${error.message}',
      "Error getting session info:', error",
      'Invalid window identifier: ${error.message}',
      "Error killing window:', error",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
