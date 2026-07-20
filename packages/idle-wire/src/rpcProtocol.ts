import * as z from 'zod';

export const MAX_RPC_SCOPE_CHARACTERS = 64;
export const MAX_RPC_METHOD_CHARACTERS = 64;
export const RPC_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
export const RPC_REQUEST_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const RPC_REPLAY_MARKER_RETENTION_MS = (
  RPC_REQUEST_MAX_AGE_MS
  + RPC_REQUEST_MAX_FUTURE_SKEW_MS
  + 60 * 1000
);

const RpcScopeSchema = z.string()
  .min(1)
  .max(MAX_RPC_SCOPE_CHARACTERS)
  .regex(/^[A-Za-z0-9_-]+$/);

const RpcMethodSchema = z.string()
  .min(1)
  .max(MAX_RPC_METHOD_CHARACTERS)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);

/**
 * Request identity and freshness stored inside authenticated RPC plaintext.
 * The relay can observe and replay the outer method/ciphertext pair, but it
 * cannot alter these fields or params without failing AEAD verification.
 */
export const AuthenticatedRpcRequestV1Schema = z.object({
  kind: z.literal('idle-rpc-request'),
  v: z.literal(1),
  scope: RpcScopeSchema,
  method: RpcMethodSchema,
  requestId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  params: z.unknown(),
}).strict();

export const AuthenticatedRpcRequestV2Schema = z.object({
  kind: z.literal('idle-rpc-request'),
  v: z.literal(2),
  scope: RpcScopeSchema,
  method: RpcMethodSchema,
  requestId: z.string().uuid(),
  issuedAt: z.number().int().nonnegative(),
  params: z.unknown(),
}).strict();

export const AuthenticatedRpcRequestSchema = z.discriminatedUnion('v', [
  AuthenticatedRpcRequestV1Schema,
  AuthenticatedRpcRequestV2Schema,
]);

export type AuthenticatedRpcRequest = z.infer<typeof AuthenticatedRpcRequestSchema>;
export type AuthenticatedRpcRequestIdentity = Pick<
  AuthenticatedRpcRequest,
  'scope' | 'method' | 'requestId'
>;

export const AuthenticatedRpcErrorCodeSchema = z.enum([
  'METHOD_NOT_FOUND',
  'HANDLER_FAILED',
  'RESULT_TOO_LARGE',
]);
export type AuthenticatedRpcErrorCode = z.infer<typeof AuthenticatedRpcErrorCodeSchema>;

const AuthenticatedRpcResponseIdentitySchema = z.object({
  kind: z.literal('idle-rpc-response'),
  v: z.literal(2),
  scope: RpcScopeSchema,
  method: RpcMethodSchema,
  requestId: z.string().uuid(),
});

export const AuthenticatedRpcResponseSchema = z.discriminatedUnion('ok', [
  AuthenticatedRpcResponseIdentitySchema.extend({
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  AuthenticatedRpcResponseIdentitySchema.extend({
    ok: z.literal(false),
    error: AuthenticatedRpcErrorCodeSchema,
  }).strict(),
]);
export type AuthenticatedRpcResponse = z.infer<typeof AuthenticatedRpcResponseSchema>;

export function createAuthenticatedRpcRequest(
  scope: string,
  method: string,
  params: unknown,
  requestId: string,
  issuedAt: number,
): AuthenticatedRpcRequest {
  return AuthenticatedRpcRequestSchema.parse({
    kind: 'idle-rpc-request',
    v: 2,
    scope,
    method,
    requestId,
    issuedAt,
    params,
  });
}

export function createAuthenticatedRpcSuccess(
  request: AuthenticatedRpcRequestIdentity,
  result: unknown,
): AuthenticatedRpcResponse {
  return AuthenticatedRpcResponseSchema.parse({
    kind: 'idle-rpc-response',
    v: 2,
    scope: request.scope,
    method: request.method,
    requestId: request.requestId,
    ok: true,
    result,
  });
}

export function createAuthenticatedRpcError(
  request: AuthenticatedRpcRequestIdentity,
  error: AuthenticatedRpcErrorCode,
): AuthenticatedRpcResponse {
  return AuthenticatedRpcResponseSchema.parse({
    kind: 'idle-rpc-response',
    v: 2,
    scope: request.scope,
    method: request.method,
    requestId: request.requestId,
    ok: false,
    error,
  });
}
