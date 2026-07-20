import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('axios', async (importOriginal) => {
  const original = await importOriginal<typeof import('axios')>();
  return {
    ...original,
    default: { get: mocks.get },
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://idle.test',
    currentCliVersion: 'test',
    idleHomeDir: '/tmp/.idle',
  },
}));

vi.mock('./localIdleAgentAuth', () => ({
  getLocalIdleAgentCredentialPath: () => '/tmp/.idle/agent.key',
  readLocalIdleAgentCredentials: () => ({
    token: 'synthetic-token',
    secret: new Uint8Array(32),
    contentKeyPair: {
      publicKey: new Uint8Array(32),
      secretKey: new Uint8Array(32),
    },
  }),
}));

import { resolveIdleSession } from './resolveIdleSession';
import { encryptSessionField } from '@/api/sessionFieldEncryption';

describe('resume session lookup boundary', () => {
  it('rejects captured metadata ciphertext relabeled to a newer outer version', async () => {
    const captured = encryptSessionField(
      { key: new Uint8Array(32), variant: 'legacy' },
      'session-a',
      'metadata',
      1,
      { path: '/captured', flavor: 'codex', codexThreadId: 'thread-1' },
    );
    mocks.get.mockResolvedValueOnce({
      data: {
        sessions: [{
          id: 'session-a',
          active: true,
          metadata: captured,
          metadataVersion: 999,
          agentState: null,
          agentStateVersion: 0,
          seq: 0,
          dataEncryptionKey: null,
        }],
      },
    });

    await expect(resolveIdleSession('session-a')).rejects.toThrow(
      'Failed to decrypt metadata for Idle session session-a',
    );
  });

  it('bounds the HTTP response and rejects an over-limit session collection before decryption', async () => {
    mocks.get.mockResolvedValueOnce({
      data: {
        sessions: Array.from({ length: 151 }, (_, index) => ({
          id: `session-${index}`,
          active: false,
          metadata: 'not-base64',
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          seq: 0,
          dataEncryptionKey: null,
        })),
      },
    });

    await expect(resolveIdleSession('session-0')).rejects.toThrow('Invalid session lookup response');

    const config = mocks.get.mock.calls[0][1] as {
      maxContentLength?: number;
      timeout?: number;
      maxRedirects?: number;
    };
    expect(config.maxContentLength).toBeGreaterThan(0);
    expect(config.maxContentLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.maxRedirects).toBe(0);
  });
});
