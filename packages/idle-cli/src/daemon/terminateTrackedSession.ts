import { setTimeout as delay } from 'node:timers/promises';
import type { TrackedSession } from './types';

const DEFAULT_GRACEFUL_TIMEOUT_MS = 3_000;
const DEFAULT_FORCE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 50;

type TerminationOptions = {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
};

function isProcessMissing(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function isTargetRunning(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return !isProcessMissing(error);
  }
}

function sendSignal(target: number, signal: NodeJS.Signals): 'sent' | 'missing' | 'failed' {
  try {
    process.kill(target, signal);
    return 'sent';
  } catch (error) {
    return isProcessMissing(error) ? 'missing' : 'failed';
  }
}

async function waitForExit(target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (isTargetRunning(target)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  return true;
}

export function getTerminationTarget(
  session: TrackedSession,
  platform: NodeJS.Platform = process.platform,
): number {
  if (!Number.isInteger(session.pid) || session.pid <= 0) {
    throw new Error('Tracked session has an invalid process ID');
  }

  // Daemon-owned sessions run in isolated process groups on POSIX (either as a
  // detached child or inside a tmux pane). Targeting the negative PID contains
  // their child process tree as well. An externally started process may share
  // its terminal's group, so only target that individual PID. Windows does not
  // support negative process-group PIDs.
  if (session.startedBy === 'daemon' && platform !== 'win32') {
    return -session.pid;
  }
  return session.pid;
}

export async function terminateTrackedSession(
  session: TrackedSession,
  options: TerminationOptions = {},
): Promise<boolean> {
  let target: number;
  try {
    target = getTerminationTarget(session);
  } catch {
    return false;
  }

  if (!isTargetRunning(target)) {
    // A tmux or platform-specific launch can violate the expected PID=PGID
    // relationship. Do not treat a missing group as proof of termination while
    // the tracked process itself is still alive.
    if (target < 0 && isTargetRunning(session.pid)) {
      target = session.pid;
    } else {
      return true;
    }
  }

  const terminateResult = sendSignal(target, 'SIGTERM');
  if (terminateResult === 'missing') {
    return true;
  }
  if (terminateResult === 'failed') {
    return false;
  }

  if (await waitForExit(target, options.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS)) {
    return true;
  }

  const killResult = sendSignal(target, 'SIGKILL');
  if (killResult === 'missing') {
    return true;
  }
  if (killResult === 'failed') {
    return false;
  }

  return waitForExit(target, options.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS);
}
