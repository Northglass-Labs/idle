import { z } from 'zod';

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();

/**
 * Encrypted session record returned by the relay.
 *
 * Bounds mirror the server's accepted encrypted-field limits and keep every
 * client from allocating or decrypting attacker-controlled response shapes.
 */
export const SessionRecordSchema = z.object({
  id: z.string().min(1).max(64),
  seq: SafeNonnegativeIntegerSchema,
  createdAt: SafeNonnegativeIntegerSchema,
  updatedAt: SafeNonnegativeIntegerSchema,
  active: z.boolean(),
  activeAt: SafeNonnegativeIntegerSchema,
  metadata: z.string().max(16 * 1024),
  metadataVersion: SafeNonnegativeIntegerSchema,
  agentState: z.string().min(1).max(64 * 1024).nullable(),
  agentStateVersion: SafeNonnegativeIntegerSchema,
  dataEncryptionKey: z.string().min(1).max(1024).nullable(),
  lastMessage: z.null().optional(),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const CreateSessionResponseSchema = z.object({
  session: SessionRecordSchema,
});

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
