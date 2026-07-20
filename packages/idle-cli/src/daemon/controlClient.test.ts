import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  state: {
    pid: process.pid,
    httpPort: 4242,
    controlToken: 'owner-only-control-token',
    startTime: 'now',
    startedWithCliVersion: '1.0.0',
  } as Record<string, unknown> | null,
}));

vi.mock('@/persistence', () => ({
  readDaemonState: vi.fn(async () => mocked.state),
  clearDaemonState: vi.fn(async () => undefined),
}));

vi.mock('@/configuration', () => ({
  configuration: { currentCliVersion: '1.0.0' },
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

import {
  checkIfDaemonRunningAndCleanupStaleState,
  listDaemonSessions,
  stopDaemon,
} from './controlClient';

describe('daemon control client authentication', () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    mocked.state = {
      pid: process.pid,
      httpPort: 4242,
      controlToken: 'owner-only-control-token',
      startTime: 'now',
      startedWithCliVersion: '1.0.0',
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      children: [],
      daemonPid: process.pid,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchMock.mockReset();
  });

  it('reads the token from owner-only daemon state and sends it as a bearer header', async () => {
    await expect(listDaemonSessions()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer owner-only-control-token',
    });
    expect(init.redirect).toBe('error');
  });

  it('fails closed when the loopback health endpoint rejects the daemon capability', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);

    const persistence = await import('@/persistence');
    expect(persistence.clearDaemonState).toHaveBeenCalledOnce();
  });

  it('never signals a stale PID when authenticated daemon shutdown was not acknowledged', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) return true;
      return true;
    }) as typeof process.kill);
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    try {
      const stopping = stopDaemon();
      await vi.runAllTimersAsync();
      await stopping;

      expect(kill.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });
});
