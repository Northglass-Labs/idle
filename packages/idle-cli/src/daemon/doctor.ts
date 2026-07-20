/**
 * Daemon doctor utilities
 *
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from 'ps-list';
import spawn from 'cross-spawn';

/**
 * Find all Idle CLI processes (including current process)
 */
export async function findAllIdleProcesses(): Promise<Array<{ pid: number, type: string }>> {
  try {
    const processes = await psList();
    const allProcesses: Array<{ pid: number, type: string }> = [];

    for (const proc of processes) {
      const cmd = proc.cmd || '';
      const name = proc.name || '';

      // Check if it's an Idle CLI process
      const isIdle = name.includes('idle') ||
                      name === 'node' && (cmd.includes('idle-cli') || cmd.includes('dist/index.mjs')) ||
                      cmd.includes('idle.mjs') ||
                      cmd.includes('idle-coder') ||
                      cmd.includes('/idle/') ||
                      (cmd.includes('tsx') && cmd.includes('src/index.ts') && cmd.includes('idle-cli'));

      if (!isIdle) continue;

      // Classify process type
      let type = 'unknown';
      if (proc.pid === process.pid) {
        type = 'current';
      } else if (cmd.includes('--version')) {
        type = cmd.includes('tsx') ? 'dev-daemon-version-check' : 'daemon-version-check';
      } else if (cmd.includes('daemon start-sync') || cmd.includes('daemon start')) {
        type = cmd.includes('tsx') ? 'dev-daemon' : 'daemon';
      } else if (cmd.includes('--started-by daemon')) {
        type = cmd.includes('tsx') ? 'dev-daemon-spawned' : 'daemon-spawned-session';
      } else if (cmd.includes('doctor')) {
        type = cmd.includes('tsx') ? 'dev-doctor' : 'doctor';
      } else if (cmd.includes('--yolo')) {
        type = 'dev-session';
      } else {
        type = cmd.includes('tsx') ? 'dev-related' : 'user-session';
      }

      allProcesses.push({ pid: proc.pid, type });
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

/**
 * Find all runaway Idle CLI processes that should be killed
 */
export async function findRunawayIdleProcesses(): Promise<Array<{ pid: number }>> {
  const allProcesses = await findAllIdleProcesses();

  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p =>
      p.pid !== process.pid && (
        p.type === 'daemon' ||
        p.type === 'dev-daemon' ||
        p.type === 'daemon-spawned-session' ||
        p.type === 'dev-daemon-spawned' ||
        p.type === 'daemon-version-check' ||
        p.type === 'dev-daemon-version-check'
      )
    )
    .map(p => ({ pid: p.pid }));
}

/**
 * Kill all runaway Idle CLI processes
 */
export async function killRunawayIdleProcesses(): Promise<{ killed: number, failed: number }> {
  const runawayProcesses = await findRunawayIdleProcesses();
  let killed = 0;
  let failed = 0;

  for (const { pid } of runawayProcesses) {
    try {
      console.log('Stopping a runaway Idle process');

      if (process.platform === 'win32') {
        // Windows: use taskkill
        const result = spawn.sync('taskkill', ['/F', '/PID', pid.toString()], { stdio: 'pipe' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`taskkill exited with code ${result.status}`);
      } else {
        // Unix: try SIGTERM first
        process.kill(pid, 'SIGTERM');

        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Check if still alive
        const processes = await psList();
        const stillAlive = processes.find(p => p.pid === pid);
        if (stillAlive) {
          console.log('A process ignored graceful shutdown; forcing termination');
          process.kill(pid, 'SIGKILL');
        }
      }

      console.log('Stopped a runaway Idle process');
      killed++;
    } catch {
      failed++;
      console.log('Failed to stop a runaway Idle process');
    }
  }

  return { killed, failed };
}
