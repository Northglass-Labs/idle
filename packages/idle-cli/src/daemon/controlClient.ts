/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { configuration } from '@/configuration';

const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedJson(response: Response): Promise<any> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTROL_RESPONSE_BYTES) {
    throw new Error('Daemon response exceeded the allowed size');
  }

  if (!response.body) {
    throw new Error('Daemon returned an empty response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Daemon response exceeded the allowed size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function daemonPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug('[CONTROL CLIENT] Daemon state is unavailable');
    return {
      error: errorMessage
    };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug('[CONTROL CLIENT] Daemon state is stale');
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.IDLE_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.IDLE_DAEMON_HTTP_TIMEOUT) : 10_000;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.controlToken) {
      headers.Authorization = `Bearer ${state.controlToken}`;
    }
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers,
       body: JSON.stringify(body || {}),
       redirect: 'error',
       // Bound loopback requests so a wedged daemon cannot stall the caller.
       signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug('[CONTROL CLIENT] Daemon request was rejected');
      return {
        error: errorMessage
      };
    }

    return await readBoundedJson(response);
  } catch (error) {
    const errorMessage = 'Daemon request failed';
    logger.debug('[CONTROL CLIENT] Daemon request failed');
    return {
      error: errorMessage
    }
  }
}

const SESSION_STARTED_RETRY_TIMEOUT_MS = 3000;
const SESSION_STARTED_RETRY_INTERVAL_MS = 100;

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  encryption?: {
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
  }
): Promise<{ error?: string } | any> {
  // Retry briefly — ensureDaemonRunning already waits for readiness, but we may
  // race a daemon that is mid-restart (version upgrade, crash recovery). Without
  // this, the session's encryption data never reaches the daemon and the mobile
  // app's resume-idle-session RPC fails with "not tracked by this daemon".
  const payload = { sessionId, metadata, encryption };
  const deadline = Date.now() + SESSION_STARTED_RETRY_TIMEOUT_MS;
  let result: { error?: string } | any;

  while (true) {
    result = await daemonPost('/session-started', payload);
    if (!result?.error) {
      return result;
    }
    if (Date.now() >= deadline) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, SESSION_STARTED_RETRY_INTERVAL_MS));
  }
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<{ daemonPid: number }> {
  const result = await daemonPost('/stop');
  if (
    result?.error
    || result?.status !== 'stopping'
    || !Number.isInteger(result?.daemonPid)
    || result.daemonPid <= 0
  ) {
    throw new Error(result?.error || 'Daemon shutdown was not acknowledged');
  }
  return { daemonPid: result.daemonPid };
}

/**
 * Verify that persisted state identifies a live daemon with an authenticated
 * control endpoint. Stale or unverifiable state is removed before returning.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the PID is alive
  try {
    process.kill(state.pid, 0);
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }

  // PID is alive, but on Windows PIDs get reused after reboot.
  // Verify it's actually our daemon by HTTP pinging its control server.
  if (state.httpPort) {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (state.controlToken) {
        headers.Authorization = `Bearer ${state.controlToken}`;
      }
      const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
        method: 'POST',
        headers,
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(2000)
      });
      if (response.ok) {
        const body = await readBoundedJson(response);
        if (body?.daemonPid === state.pid) {
          return true;
        }
      }
    } catch {
      // Fall through to stale-state cleanup below.
    }

    // HTTP rejection, malformed response, or PID mismatch means the persisted
    // process identity is unproven. Never trust a live PID by itself because
    // operating systems reuse them after the original daemon exits.
    logger.debug('[DAEMON RUN] Live process failed daemon identity verification; cleaning up stale state');
    await cleanupDaemonState();
    return false;
  }

  return true;
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 *
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledIdleVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }

  // Compare two versions baked into executable bundles. Reading a mutable
  // manifest here can disagree with the running code and create a restart loop.
  const currentCliVersion = configuration.currentCliVersion;
  logger.debug('[DAEMON CONTROL] Compared daemon and CLI versions');
  return currentCliVersion === state.startedWithCliVersion;
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata');
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug('Stopping daemon');

    // The authenticated control response must identify the same process as the
    // state file before we are allowed to signal that PID. A stale PID can
    // otherwise refer to an unrelated user process after daemon exit.
    let shutdownAcknowledged = false;
    try {
      const acknowledgment = await stopDaemonHttp();
      if (acknowledgment.daemonPid !== state.pid) {
        logger.debug('Daemon shutdown acknowledgment did not match persisted PID');
        return;
      }
      shutdownAcknowledged = true;

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch {
      if (!shutdownAcknowledged) {
        logger.debug('HTTP stop failed before daemon identity was verified; refusing to signal stale PID');
        return;
      }
      logger.debug('Verified daemon did not stop gracefully, will force kill');
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch {
    logger.debug('Error stopping daemon');
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
