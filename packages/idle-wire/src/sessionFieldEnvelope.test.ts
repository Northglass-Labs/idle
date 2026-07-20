import { describe, expect, it } from 'vitest';
import {
  AuthenticatedSessionFieldEnvelopeSchema,
  createAuthenticatedSessionFieldEnvelope,
  isAuthenticatedSessionFieldEnvelopeCandidate,
  readAuthenticatedSessionFieldEnvelope,
} from './sessionFieldEnvelope';

describe('authenticated session field envelopes', () => {
  it('round-trips only under the exact session, field, and version', () => {
    const envelope = createAuthenticatedSessionFieldEnvelope(
      'session-a',
      'agentState',
      7,
      { controlledByUser: false },
    );

    expect(readAuthenticatedSessionFieldEnvelope(envelope, {
      sessionId: 'session-a',
      field: 'agentState',
      version: 7,
    })).toEqual({ success: true, value: { controlledByUser: false } });
    expect(readAuthenticatedSessionFieldEnvelope(envelope, {
      sessionId: 'session-b',
      field: 'agentState',
      version: 7,
    })).toEqual({ success: false });
    expect(readAuthenticatedSessionFieldEnvelope(envelope, {
      sessionId: 'session-a',
      field: 'metadata',
      version: 7,
    })).toEqual({ success: false });
    expect(readAuthenticatedSessionFieldEnvelope(envelope, {
      sessionId: 'session-a',
      field: 'agentState',
      version: 999,
    })).toEqual({ success: false });
  });

  it('rejects unbounded, unsafe, and non-object payloads', () => {
    const base = {
      kind: 'idle-session-field',
      v: 1,
      sessionId: 'session-a',
      field: 'metadata',
      version: 0,
      value: { path: '/workspace' },
    };

    expect(AuthenticatedSessionFieldEnvelopeSchema.safeParse({
      ...base,
      sessionId: 's'.repeat(257),
    }).success).toBe(false);
    expect(isAuthenticatedSessionFieldEnvelopeCandidate(base)).toBe(true);
    expect(isAuthenticatedSessionFieldEnvelopeCandidate({ path: '/legacy' })).toBe(false);
    expect(AuthenticatedSessionFieldEnvelopeSchema.safeParse({
      ...base,
      version: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
    expect(AuthenticatedSessionFieldEnvelopeSchema.safeParse({
      ...base,
      value: ['not', 'a', 'field'],
    }).success).toBe(false);
    expect(AuthenticatedSessionFieldEnvelopeSchema.safeParse({
      ...base,
      extra: true,
    }).success).toBe(false);
  });
});
