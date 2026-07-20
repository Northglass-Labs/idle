import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  crossSpawn: vi.fn(),
  existsSync: vi.fn(() => true),
  loggerDebug: vi.fn(),
  projectRoot: '/private/opaque-project-root-sentinel',
}));

vi.mock('cross-spawn', () => ({ spawn: mocks.crossSpawn }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: mocks.existsSync };
});
vi.mock('@/projectPath', () => ({ projectPath: () => mocks.projectRoot }));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.loggerDebug } }));
vi.mock('./runtime', () => ({ isBun: () => false }));

import { spawnIdleCLI } from './spawnIdleCLI';

function renderedDiagnostics(): string {
  return mocks.loggerDebug.mock.calls
    .flat()
    .map((value) => value instanceof Error ? value.message : String(value))
    .join('\n');
}

describe('spawnIdleCLI diagnostic privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
  });

  it('passes exact launch data to the child without persisting argv, provider IDs, or cwd', () => {
    const providerId = 'provider-thread-private-sentinel';
    const prompt = 'opaque-user-command-private-sentinel';
    const cwd = '/Users/private-person/private-workspace-sentinel';
    const child = { pid: 4242 };
    mocks.crossSpawn.mockReturnValue(child);

    const result = spawnIdleCLI(
      ['codex', '--resume', providerId, '--prompt', prompt],
      { cwd, detached: true },
    );

    expect(result).toBe(child);
    expect(mocks.crossSpawn).toHaveBeenCalledWith(
      'node',
      [
        '--no-warnings',
        '--no-deprecation',
        `${mocks.projectRoot}/dist/index.mjs`,
        'codex',
        '--resume',
        providerId,
        '--prompt',
        prompt,
      ],
      expect.objectContaining({ cwd, detached: true, windowsHide: true }),
    );

    const diagnostics = renderedDiagnostics();
    expect(diagnostics).not.toContain(providerId);
    expect(diagnostics).not.toContain(prompt);
    expect(diagnostics).not.toContain(cwd);
    expect(diagnostics).not.toContain(mocks.projectRoot);
  });

  it('reports a stable missing-entrypoint failure without persisting its absolute path', () => {
    mocks.existsSync.mockReturnValue(false);

    expect(() => spawnIdleCLI(['claude'])).toThrow('Idle CLI entrypoint is unavailable');
    expect(mocks.crossSpawn).not.toHaveBeenCalled();
    expect(renderedDiagnostics()).not.toContain(mocks.projectRoot);
  });
});
