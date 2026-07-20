/**
 * Integration tests for daemon HTTP control system
 *
 * Tests the full flow of daemon startup, session tracking, and shutdown
 *
 * This file boots one authenticated Idle environment and restarts the daemon
 * inside that env for each test against the copied lab-rat project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildProcess } from 'child_process';
import { existsSync, lstatSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { io } from 'socket.io-client';
import { createAuthenticatedRpcRequest } from '@northglass/idle-wire';
import type { Metadata } from '@/api/types';
import { getIntegrationEnv } from '@/testing/currentIntegrationEnv';
import { configuration } from '@/configuration';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import {
  listDaemonSessions,
  notifyDaemonSessionStarted,
  spawnDaemonSession,
  stopDaemon,
  stopDaemonHttp,
  stopDaemonSession,
} from '@/daemon/controlClient';
import { clearDaemonState, readCredentials, readDaemonState, readSettings } from '@/persistence';
import { spawnIdleCLI } from '@/utils/spawnIdleCLI';

type DaemonState = NonNullable<Awaited<ReturnType<typeof readDaemonState>>>;

const DAEMON_LIFECYCLE_TIMEOUT_MS = 20_000;
const SESSION_READINESS_TIMEOUT_MS = 25_000;

async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
  timeout = DAEMON_LIFECYCLE_TIMEOUT_MS,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const integrationEnv = getIntegrationEnv();

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeDaemonState(): Promise<DaemonState | null> {
  const state = await readDaemonState();
  if (!state || !state.controlToken) {
    return null;
  }

  if (!processIsAlive(state.pid)) {
    return null;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${state.httpPort}/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.controlToken}`,
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return null;
    }

    const body = await response.json() as { daemonPid?: unknown; children?: unknown };
    return body.daemonPid === state.pid && Array.isArray(body.children) ? state : null;
  } catch {
    return null;
  }
}

async function waitForReadyDaemon(child: ChildProcess): Promise<DaemonState> {
  if (!child.pid) {
    throw new Error('Daemon process did not receive a PID');
  }

  let readyState: DaemonState | null = null;
  let spawnFailed = false;
  child.once('error', () => {
    spawnFailed = true;
  });

  await waitFor(async () => {
    readyState = await probeDaemonState();
    if (readyState) {
      return true;
    }
    if (spawnFailed || childHasExited(child)) {
      throw new Error('Daemon process exited before its authenticated control endpoint became ready');
    }
    return false;
  }, 'a fresh authenticated daemon control endpoint');

  return readyState!;
}

async function stopAllTrackedSessions(): Promise<void> {
  const sessions = await listDaemonSessions().catch(() => []);

  await Promise.all(
    sessions.map((session: any) =>
      stopDaemonSession(session.idleSessionId ?? `PID-${session.pid}`).catch(() => false)
    ),
  );
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) {
    return;
  }

  child.kill('SIGTERM');
  try {
    await waitFor(async () => childHasExited(child), 'a test child process to exit', 5_000, 50);
  } catch {
    if (!childHasExited(child)) {
      child.kill('SIGKILL');
    }
    await waitFor(async () => childHasExited(child), 'a force-killed test child process to exit', 5_000, 50);
  }
}

async function stopCurrentDaemon(daemonProcess?: ChildProcess): Promise<void> {
  const state = await readDaemonState();
  await stopAllTrackedSessions().catch(() => undefined);
  await stopDaemon().catch(() => undefined);

  if (state) {
    await waitFor(
      async () => !processIsAlive(state.pid),
      'the authenticated daemon process to exit',
    );

    const currentState = await readDaemonState();
    if (currentState?.pid === state.pid) {
      await clearDaemonState();
    }
  }

  if (daemonProcess && !childHasExited(daemonProcess)) {
    await waitFor(
      async () => childHasExited(daemonProcess),
      'the daemon child process to be reaped',
    );
  }

  await waitFor(
    async () => (await readDaemonState()) === null,
    'daemon state cleanup',
  );
}

describe('Daemon Integration Tests', { timeout: 180_000 }, () => {
  let daemonPid: number;
  let daemonLogPath: string;
  let daemonProcess: ChildProcess | undefined;
  const testChildren = new Set<ChildProcess>();

  beforeEach(async () => {
    await stopCurrentDaemon(daemonProcess);
    daemonProcess = undefined;

    daemonProcess = spawnIdleCLI(['daemon', 'start-sync'], {
      stdio: 'ignore',
      env: process.env,
    });

    const daemonState = await waitForReadyDaemon(daemonProcess);
    daemonPid = daemonState.pid;
    if (!daemonState.daemonLogPath) {
      throw new Error('Ready daemon state did not include its log path');
    }
    daemonLogPath = daemonState.daemonLogPath;
  });

  afterEach(async () => {
    await Promise.all(Array.from(testChildren, child => terminateChild(child)));
    testChildren.clear();
    await stopCurrentDaemon(daemonProcess);
    daemonProcess = undefined;
  });

  it('should list sessions (initially empty)', async () => {
    const sessions = await listDaemonSessions();
    expect(sessions).toEqual([]);
  });

  it('uses the seeded purpose credential to register machine RPC handlers', async () => {
    const credentials = await readCredentials();
    const settings = await readSettings();
    expect(credentials).not.toBeNull();
    expect(credentials?.rpcRegistrationToken).toEqual(expect.any(String));
    expect(credentials?.rpcRegistrationToken).not.toBe(credentials?.token);
    expect(lstatSync(path.join(configuration.idleHomeDir, 'access.key')).mode & 0o777).toBe(0o600);
    if (!credentials || credentials.encryption.type !== 'legacy' || !settings.machineId) {
      throw new Error('Seeded legacy credentials and machine identity are required');
    }

    const socket = io(configuration.serverUrl.replace(/^http/, 'ws'), {
      transports: ['websocket'],
      auth: { token: credentials.token, happyClient: 'cli-integration/seed-rpc' },
      path: '/v1/updates',
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('User RPC socket did not connect')), 5_000);
        socket.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once('connect_error', error => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const request = createAuthenticatedRpcRequest(
        settings.machineId,
        'stop-session',
        { sessionId: randomUUID() },
        randomUUID(),
        Date.now(),
      );
      const result = await socket.timeout(20_000).emitWithAck('rpc-call', {
        method: `${settings.machineId}:stop-session`,
        params: encodeBase64(encrypt(credentials.encryption.secret, 'legacy', request)),
      }) as { ok: boolean; result?: string; error?: string };

      expect(result.ok).toBe(true);
      expect(result.result).toEqual(expect.any(String));
      expect(decrypt(
        credentials.encryption.secret,
        'legacy',
        decodeBase64(result.result!),
      )).toEqual({
        kind: 'idle-rpc-response',
        v: 2,
        scope: settings.machineId,
        method: 'stop-session',
        requestId: request.requestId,
        ok: false,
        error: 'HANDLER_FAILED',
      });
    } finally {
      socket.close();
    }
  });

  it('should track session-started webhook from terminal session', async () => {
    // Simulate a terminal-started session reporting to daemon
    const mockMetadata: Metadata = {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      idleHomeDir: '/test/idle-home',
      idleLibDir: '/test/idle-lib',
      idleToolsDir: '/test/idle-tools',
      hostPid: 99999,
      startedBy: 'terminal',
      machineId: 'test-machine-123'
    };

    await notifyDaemonSessionStarted('test-session-123', mockMetadata);

    // Verify session is tracked
    const sessions = await listDaemonSessions();
    expect(sessions).toHaveLength(1);

    const tracked = sessions[0];
    expect(tracked.startedBy).toBe('idle directly - likely by user from terminal');
    expect(tracked.idleSessionId).toBe('test-session-123');
    expect(tracked.pid).toBe(99999);
  });

  it('should spawn & stop a session via HTTP (not testing RPC route, but similar enough)', async () => {
    const response = await spawnDaemonSession(integrationEnv.projectPath, 'spawned-test-456');

    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('sessionId');

    // Verify session is tracked
    const sessions = await listDaemonSessions();
    const spawnedSession = sessions.find(
      (s: any) => s.idleSessionId === response.sessionId
    );

    expect(spawnedSession).toBeDefined();
    expect(spawnedSession.startedBy).toBe('daemon');

    // Clean up - stop the spawned session
    expect(spawnedSession.idleSessionId).toBeDefined();
    await stopDaemonSession(spawnedSession.idleSessionId);
  });

  it('stress test: spawn / stop', { timeout: 60_000 }, async () => {
    const sessionCount = 20;
    const maxConcurrentLifecycles = 5;
    const lifecycleResults: Array<{ spawned: boolean; stopped: boolean }> = [];
    for (let offset = 0; offset < sessionCount; offset += maxConcurrentLifecycles) {
      const batchSize = Math.min(maxConcurrentLifecycles, sessionCount - offset);
      const batchResults = await Promise.all(
        Array.from({ length: batchSize }, async () => {
          const result = await spawnDaemonSession(integrationEnv.projectPath);
          const spawned = result?.success === true && typeof result.sessionId === 'string';
          if (!spawned) {
            return { spawned: false, stopped: false };
          }

          // Stop each process as soon as its own readiness webhook completes.
          // Waiting for all twenty provider launches at once lets early sessions
          // exit naturally and overloads the provider boundary rather than the
          // daemon control lifecycle this test is meant to exercise.
          return { spawned: true, stopped: await stopDaemonSession(result.sessionId) };
        }),
      );
      lifecycleResults.push(...batchResults);
    }
    expect(lifecycleResults).toHaveLength(sessionCount);
    expect(lifecycleResults.every(result => result.spawned), 'Not all sessions reported ready').toBe(true);
    expect(lifecycleResults.every(result => result.stopped), 'Not all sessions reported stopped').toBe(true);

    await waitFor(
      async () => (await listDaemonSessions()).length === 0,
      'all stress-test sessions to leave daemon tracking',
    );
  });

  it('should handle daemon stop request gracefully', async () => {
    const acknowledgment = await stopDaemonHttp();
    expect(acknowledgment.daemonPid).toBe(daemonPid);

    await waitFor(
      async () => !processIsAlive(daemonPid) && !existsSync(configuration.daemonStateFile),
      'the daemon stop request to remove process and state',
    );
  });

  it('should track both daemon-spawned and terminal sessions', async () => {
    // Spawn a real idle process that looks like it was started from terminal
    const terminalIdleProcess = spawnIdleCLI([
      '--idle-starting-mode', 'remote',
      '--started-by', 'terminal'
    ], {
      cwd: integrationEnv.projectPath,
      stdio: 'ignore'
    });
    testChildren.add(terminalIdleProcess);
    if (!terminalIdleProcess || !terminalIdleProcess.pid) {
      throw new Error('Failed to spawn terminal idle process');
    }

    await waitFor(
      async () => (await listDaemonSessions()).some((session: any) => session.pid === terminalIdleProcess.pid),
      'the terminal-started session to report readiness',
      SESSION_READINESS_TIMEOUT_MS,
    );

    // Spawn a daemon session
    const spawnResponse = await spawnDaemonSession(integrationEnv.projectPath, 'daemon-session-bbb');
    expect(spawnResponse).toHaveProperty('success', true);

    // List all sessions
    let sessions: any[] = [];
    await waitFor(async () => {
      sessions = await listDaemonSessions();
      return sessions.some((session: any) => session.pid === terminalIdleProcess.pid)
        && sessions.some((session: any) => session.idleSessionId === spawnResponse.sessionId);
    }, 'both terminal-started and daemon-started sessions to be tracked', SESSION_READINESS_TIMEOUT_MS);
    expect(sessions).toHaveLength(2);

    // Verify we have one of each type
    const terminalSession = sessions.find(
      (s: any) => s.pid === terminalIdleProcess.pid
    );
    const daemonSession = sessions.find(
      (s: any) => s.idleSessionId === spawnResponse.sessionId
    );

    expect(terminalSession).toBeDefined();
    expect(terminalSession.startedBy).toBe('idle directly - likely by user from terminal');

    expect(daemonSession).toBeDefined();
    expect(daemonSession.startedBy).toBe('daemon');

    // Clean up both sessions
    await stopDaemonSession(terminalSession.idleSessionId);
    await stopDaemonSession(daemonSession.idleSessionId);
    await terminateChild(terminalIdleProcess);
    testChildren.delete(terminalIdleProcess);
  });

  it('should update session metadata when webhook is called', async () => {
    // Spawn a session
    const spawnResponse = await spawnDaemonSession(integrationEnv.projectPath);

    // Verify webhook was processed (session ID updated)
    const sessions = await listDaemonSessions();
    const session = sessions.find((s: any) => s.idleSessionId === spawnResponse.sessionId);
    expect(session).toBeDefined();

    // Clean up
    await stopDaemonSession(spawnResponse.sessionId);
  });

  it('should not allow starting a second daemon', async () => {
    // Daemon is already running from beforeEach
    const secondChild = spawnIdleCLI(['daemon', 'start-sync'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    testChildren.add(secondChild);

    let output = '';
    let spawnFailed = false;
    const appendOutput = (data: Buffer | string) => {
      output = (output + data.toString()).slice(-32 * 1024);
    };
    secondChild.stdout?.on('data', (data) => {
      appendOutput(data);
    });
    secondChild.stderr?.on('data', (data) => {
      appendOutput(data);
    });
    secondChild.once('error', () => {
      spawnFailed = true;
    });

    await waitFor(async () => childHasExited(secondChild), 'the second daemon attempt to exit');
    testChildren.delete(secondChild);

    // Should report that daemon is already running
    expect(spawnFailed).toBe(false);
    expect(output).toContain('already running');
  });

  it('should handle concurrent session operations', async () => {
    // Spawn multiple sessions concurrently
    const promises = [];
    for (let i = 0; i < 3; i++) {
      promises.push(
        spawnDaemonSession(integrationEnv.projectPath)
      );
    }

    const results = await Promise.all(promises);

    // All should succeed
    results.forEach(res => {
      expect(res.success).toBe(true);
      expect(res.sessionId).toBeDefined();
    });

    // Collect session IDs for tracking
    const spawnedSessionIds = results.map(r => r.sessionId);

    // List should show all sessions once their successful spawn responses return.
    let sessions: any[] = [];
    await waitFor(async () => {
      sessions = await listDaemonSessions();
      return spawnedSessionIds.every(sessionId =>
        sessions.some((session: any) => session.idleSessionId === sessionId)
      );
    }, 'all concurrently spawned sessions to be visible');
    const daemonSessions = sessions.filter(
      (s: any) => s.startedBy === 'daemon' && spawnedSessionIds.includes(s.idleSessionId)
    );
    expect(daemonSessions.length).toBeGreaterThanOrEqual(3);

    // Stop all spawned sessions
    for (const session of daemonSessions) {
      expect(session.idleSessionId).toBeDefined();
      await stopDaemonSession(session.idleSessionId);
    }
  });

  it('should die with logs when SIGKILL is sent', async () => {
    expect(existsSync(daemonLogPath)).toBe(true);

    // Send SIGKILL to daemon (force kill)
    process.kill(daemonPid, 'SIGKILL');

    await waitFor(
      async () => !processIsAlive(daemonPid) && Boolean(daemonProcess && childHasExited(daemonProcess)),
      'the SIGKILLed daemon to exit',
      5_000,
      50,
    );
    expect(existsSync(daemonLogPath)).toBe(true);

    // Clean up state file manually since daemon couldn't do it
    await clearDaemonState();
  });

  it('should die with cleanup logs when SIGTERM is sent', async () => {
    // Send SIGTERM to daemon (graceful shutdown)
    process.kill(daemonPid, 'SIGTERM');

    await waitFor(
      async () => !processIsAlive(daemonPid)
        && Boolean(daemonProcess && childHasExited(daemonProcess))
        && !existsSync(configuration.daemonStateFile),
      'the SIGTERM daemon cleanup to finish',
    );

    // Read the log file to check for cleanup messages
    const logContent = readFileSync(daemonLogPath, 'utf8');

    // Should contain cleanup messages
    expect(logContent).toContain('SIGTERM');
    expect(logContent).toContain('cleanup');

    // Clean up state file if it still exists (should have been cleaned by SIGTERM handler)
    await clearDaemonState();
  });

});
