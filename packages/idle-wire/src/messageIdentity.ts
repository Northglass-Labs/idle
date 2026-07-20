import * as z from 'zod';

export const MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS = 128;
export const MAX_AUTHENTICATED_SESSION_ID_CHARACTERS = 256;

/**
 * Sender-created identity stored inside encrypted message plaintext. The relay
 * can replace outer row IDs and sequence numbers, but cannot alter these fields
 * without failing authenticated decryption.
 */
export const AuthenticatedMessageIdentitySchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1).max(MAX_AUTHENTICATED_SESSION_ID_CHARACTERS),
  messageId: z.string().min(1).max(MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS),
}).strict();

export type AuthenticatedMessageIdentity = z.infer<typeof AuthenticatedMessageIdentitySchema>;

export function createAuthenticatedMessageIdentity(
  sessionId: string,
  messageId: string,
): AuthenticatedMessageIdentity {
  return AuthenticatedMessageIdentitySchema.parse({
    v: 1,
    sessionId,
    messageId,
  });
}
