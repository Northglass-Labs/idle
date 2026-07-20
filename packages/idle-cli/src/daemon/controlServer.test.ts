import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';

const stops: Array<() => Promise<void>> = [];
const CONTROL_TOKEN = 'd'.repeat(43);

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

describe('startDaemonControlServer', () => {
  it('requires the owner-only daemon bearer token for every control route', async () => {
    const requestShutdown = vi.fn();
    const control = await startDaemonControlServer({
      authToken: CONTROL_TOKEN,
      getChildren: () => [],
      stopSession: vi.fn(() => false),
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'unused' })),
      requestShutdown,
      onIdleSessionWebhook: vi.fn(),
    });
    stops.push(control.stop);
    const url = `http://127.0.0.1:${control.port}`;

    const unauthenticated = await fetch(`${url}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauthenticated.status).toBe(401);

    const wrongToken = await fetch(`${url}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: '{}',
    });
    expect(wrongToken.status).toBe(401);
    expect(requestShutdown).not.toHaveBeenCalled();

    const authenticated = await fetch(`${url}/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONTROL_TOKEN}`,
      },
      body: '{}',
    });
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toEqual({
      children: [],
      daemonPid: process.pid,
    });
  });

  it('waits for containment before acknowledging a session stop', async () => {
    let finishContainment!: (success: boolean) => void;
    const stopSession = vi.fn(() => new Promise<boolean>((resolve) => {
      finishContainment = resolve;
    }));
    const control = await startDaemonControlServer({
      authToken: CONTROL_TOKEN,
      getChildren: () => [],
      stopSession,
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'unused' })),
      requestShutdown: vi.fn(),
      onIdleSessionWebhook: vi.fn(),
    });
    stops.push(control.stop);

    let acknowledged = false;
    const response = fetch(`http://127.0.0.1:${control.port}/stop-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONTROL_TOKEN}`,
      },
      body: JSON.stringify({ sessionId: 'session-1' }),
    }).then((result) => {
      acknowledged = true;
      return result;
    });

    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledWith('session-1'));
    expect(acknowledged).toBe(false);

    finishContainment(true);
    const acknowledgedResponse = await response;
    expect(acknowledgedResponse.status).toBe(200);
    await expect(acknowledgedResponse.json()).resolves.toEqual({ success: true });
  });

  it('rejects a weak control capability before opening a listener', async () => {
    await expect(startDaemonControlServer({
      authToken: 'short-token',
      getChildren: () => [],
      stopSession: vi.fn(() => false),
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'unused' })),
      requestShutdown: vi.fn(),
      onIdleSessionWebhook: vi.fn(),
    })).rejects.toThrow('Invalid daemon control token');
  });

  it('rejects malformed session encryption data before mutating daemon state', async () => {
    const onIdleSessionWebhook = vi.fn();
    const control = await startDaemonControlServer({
      authToken: CONTROL_TOKEN,
      getChildren: () => [],
      stopSession: vi.fn(() => false),
      spawnSession: vi.fn(async () => ({ type: 'error' as const, errorMessage: 'unused' })),
      requestShutdown: vi.fn(),
      onIdleSessionWebhook,
    });
    stops.push(control.stop);

    const response = await fetch(`http://127.0.0.1:${control.port}/session-started`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONTROL_TOKEN}`,
      },
      body: JSON.stringify({
        sessionId: 'session-1',
        metadata: { path: '/tmp/project' },
        encryption: {
          encryptionKey: Buffer.alloc(31).toString('base64'),
          encryptionVariant: 'dataKey',
          seq: -1,
          metadataVersion: 0,
          agentStateVersion: 0,
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(onIdleSessionWebhook).not.toHaveBeenCalled();
  });

  it.each([
    ['relative directory', { directory: 'relative/project' }],
    ['unknown field', { directory: '/tmp/project', providerToken: 'must-not-forward' }],
    ['invalid environment key', { directory: '/tmp/project', environmentVariables: { 'BAD-NAME': 'value' } }],
  ])('rejects a %s at the loopback spawn boundary', async (_label, body) => {
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }));
    const control = await startDaemonControlServer({
      authToken: CONTROL_TOKEN,
      getChildren: () => [],
      stopSession: vi.fn(() => false),
      spawnSession,
      requestShutdown: vi.fn(),
      onIdleSessionWebhook: vi.fn(),
    });
    stops.push(control.stop);

    const response = await fetch(`http://127.0.0.1:${control.port}/spawn-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONTROL_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
