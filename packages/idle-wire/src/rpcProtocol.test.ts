import { describe, expect, it } from 'vitest';

import {
  AuthenticatedRpcRequestSchema,
  AuthenticatedRpcResponseSchema,
  RPC_REPLAY_MARKER_RETENTION_MS,
  RPC_REQUEST_MAX_AGE_MS,
  RPC_REQUEST_MAX_FUTURE_SKEW_MS,
  createAuthenticatedRpcRequest,
  createAuthenticatedRpcError,
  createAuthenticatedRpcSuccess,
} from './rpcProtocol';

describe('authenticated RPC request protocol', () => {
  it('creates a strict versioned request with opaque params', () => {
    expect(createAuthenticatedRpcRequest(
      'session-1',
      'bash',
      { command: 'pwd' },
      '11111111-1111-4111-8111-111111111111',
      1_750_000_000_000,
    )).toEqual({
      kind: 'idle-rpc-request',
      v: 2,
      scope: 'session-1',
      method: 'bash',
      requestId: '11111111-1111-4111-8111-111111111111',
      issuedAt: 1_750_000_000_000,
      params: { command: 'pwd' },
    });
  });

  it.each([
    { kind: 'idle-rpc-request', v: 3, scope: 'session-1', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: 1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: '../session', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: 1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: '1bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: 1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: 'bash', requestId: 'not-a-uuid', issuedAt: 1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: -1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: Number.MAX_SAFE_INTEGER + 1, params: {} },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: 1 },
    { kind: 'idle-rpc-request', v: 1, scope: 'session-1', method: 'bash', requestId: '11111111-1111-4111-8111-111111111111', issuedAt: 1, params: {}, extra: true },
  ])('rejects malformed or ambiguous request identity %#', (value) => {
    expect(AuthenticatedRpcRequestSchema.safeParse(value).success).toBe(false);
  });

  it('retains replay markers beyond the entire accepted freshness window', () => {
    expect(RPC_REPLAY_MARKER_RETENTION_MS).toBeGreaterThan(
      RPC_REQUEST_MAX_AGE_MS + RPC_REQUEST_MAX_FUTURE_SKEW_MS,
    );
  });

  it('binds success and error responses to the authenticated request identity', () => {
    const request = createAuthenticatedRpcRequest(
      'machine-1',
      'spawn-idle-session',
      { directory: '/workspace' },
      '11111111-1111-4111-8111-111111111111',
      1_750_000_000_000,
    );

    expect(createAuthenticatedRpcSuccess(request, { sessionId: 'session-1' })).toEqual({
      kind: 'idle-rpc-response',
      v: 2,
      scope: 'machine-1',
      method: 'spawn-idle-session',
      requestId: '11111111-1111-4111-8111-111111111111',
      ok: true,
      result: { sessionId: 'session-1' },
    });
    expect(createAuthenticatedRpcError(request, 'METHOD_NOT_FOUND')).toEqual({
      kind: 'idle-rpc-response',
      v: 2,
      scope: 'machine-1',
      method: 'spawn-idle-session',
      requestId: '11111111-1111-4111-8111-111111111111',
      ok: false,
      error: 'METHOD_NOT_FOUND',
    });
  });

  it.each([
    { kind: 'idle-rpc-response', v: 1, scope: 'machine-1', method: 'spawn', requestId: '11111111-1111-4111-8111-111111111111', ok: true, result: {} },
    { kind: 'idle-rpc-response', v: 2, scope: 'machine-1', method: 'spawn', requestId: 'not-a-uuid', ok: true, result: {} },
    { kind: 'idle-rpc-response', v: 2, scope: 'machine-1', method: 'spawn', requestId: '11111111-1111-4111-8111-111111111111', ok: false, error: 'raw provider error' },
    { kind: 'idle-rpc-response', v: 2, scope: 'machine-1', method: 'spawn', requestId: '11111111-1111-4111-8111-111111111111', ok: true, result: {}, extra: true },
  ])('rejects malformed or ambiguous response identity %#', (value) => {
    expect(AuthenticatedRpcResponseSchema.safeParse(value).success).toBe(false);
  });
});
