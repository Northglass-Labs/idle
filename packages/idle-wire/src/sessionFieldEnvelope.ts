import * as z from 'zod';

export const MAX_AUTHENTICATED_SESSION_FIELD_ID_CHARACTERS = 256;

export const AuthenticatedSessionFieldNameSchema = z.enum([
  'metadata',
  'agentState',
]);

export type AuthenticatedSessionFieldName = z.infer<
  typeof AuthenticatedSessionFieldNameSchema
>;

/**
 * A session field plus the relay-visible coordinates under which it is valid.
 * The whole envelope is encrypted with authenticated encryption, preventing a
 * relay from moving a valid old value to another session, field, or version.
 */
export const AuthenticatedSessionFieldEnvelopeSchema = z.object({
  kind: z.literal('idle-session-field'),
  v: z.literal(1),
  sessionId: z.string()
    .min(1)
    .max(MAX_AUTHENTICATED_SESSION_FIELD_ID_CHARACTERS),
  field: AuthenticatedSessionFieldNameSchema,
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  value: z.record(z.string(), z.unknown()),
}).strict();

export type AuthenticatedSessionFieldEnvelope = z.infer<
  typeof AuthenticatedSessionFieldEnvelopeSchema
>;

export type AuthenticatedSessionFieldReadResult =
  | { success: true; value: Record<string, unknown> }
  | { success: false };

export function isAuthenticatedSessionFieldEnvelopeCandidate(
  value: unknown,
): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === 'idle-session-field';
}

export function createAuthenticatedSessionFieldEnvelope(
  sessionId: string,
  field: AuthenticatedSessionFieldName,
  version: number,
  value: Record<string, unknown>,
): AuthenticatedSessionFieldEnvelope {
  return AuthenticatedSessionFieldEnvelopeSchema.parse({
    kind: 'idle-session-field',
    v: 1,
    sessionId,
    field,
    version,
    value,
  });
}

export function readAuthenticatedSessionFieldEnvelope(
  plaintext: unknown,
  expected: {
    sessionId: string;
    field: AuthenticatedSessionFieldName;
    version: number;
  },
): AuthenticatedSessionFieldReadResult {
  const parsed = AuthenticatedSessionFieldEnvelopeSchema.safeParse(plaintext);
  if (
    !parsed.success
    || parsed.data.sessionId !== expected.sessionId
    || parsed.data.field !== expected.field
    || parsed.data.version !== expected.version
  ) {
    return { success: false };
  }

  return { success: true, value: parsed.data.value };
}
