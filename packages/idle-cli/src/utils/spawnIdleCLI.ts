/**
 * Cross-platform Idle CLI spawning utility
 *
 * ## Background
 *
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 *
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Idle.
 *
 * ## The Wrapper Strategy
 *
 * We created a wrapper script `bin/idle.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates
 * Windows-specific wrapper scripts (`idle.cmd` and `idle.ps1`) when it sees
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 *
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 *
 * ## Execution Chains
 *
 * **Unix/Linux/macOS:**
 * 1. User runs `idle` command
 * 2. Shell directly executes `bin/idle.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/idle.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 *
 * **Windows:**
 * 1. User runs `idle` command
 * 2. NPM wrapper (`idle.cmd`) calls `node bin/idle.mjs`
 * 3. `bin/idle.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 *
 * ## The Spawning Problem
 *
 * When our code needs to spawn Idle CLI as a subprocess (for daemon processes),
 * we were trying to execute `bin/idle.mjs` directly. This fails on Windows
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 *
 * ## The Solution
 *
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 *
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 *
 * This works on all platforms and achieves the same result without any of the
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { SpawnOptions, type ChildProcess } from 'child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';

/**
 * Spawn the Idle CLI with the given arguments in a cross-platform way.
 *
 * This function bypasses the wrapper script (bin/idle.mjs) and spawns the
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 *
 * @param args - Arguments to pass to the Idle CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnIdleCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'idle' wrapper that would normally be found in the shell's PATH.
  // Launch arguments can include provider conversation identifiers and user
  // content, while cwd can expose local identity. Persist only bounded shape.
  logger.debug('[SPAWN IDLE CLI] Starting child process', {
    argumentCount: args.length,
    hasCustomWorkingDirectory: 'cwd' in options,
    isDetached: options.detached === true,
    hasCustomEnvironment: options.env !== undefined,
  });

  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    logger.debug('[SPAWN IDLE CLI] Entrypoint is unavailable');
    throw new Error('Idle CLI entrypoint is unavailable');
  }

  const runtime = isBun() ? 'bun' : 'node';
  // Use cross-spawn so `node` resolves to `node.exe` on Windows.
  // Since Node's CVE-2024-27980 hardening, child_process.spawn('node', ...)
  // on Windows no longer falls back to appending `.exe`, producing ENOENT
  // even when node is on PATH.
  return crossSpawn(runtime, nodeArgs, {
    windowsHide: true,
    ...options,
  });
}
