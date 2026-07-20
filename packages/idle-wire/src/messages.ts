import * as z from 'zod';
import { sessionEnvelopeSchema } from './sessionProtocol';
import { MessageMetaSchema, type MessageMeta } from './messageMeta';
import { AgentMessageSchema, UserMessageSchema } from './legacyProtocol';
import { AuthenticatedMessageIdentitySchema } from './messageIdentity';

export const MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_LIVE_UPDATE_ID_CHARACTERS = 64;
export const MAX_LIVE_UPDATE_CONTAINER_ID_CHARACTERS = 128;
export const MAX_LIVE_UPDATE_TIMESTAMP_MS = 253_402_300_799_000;
const LiveUpdateIdSchema = z.string().min(1).max(MAX_LIVE_UPDATE_ID_CHARACTERS);
const LiveUpdateContainerIdSchema = z.string().min(1).max(MAX_LIVE_UPDATE_CONTAINER_ID_CHARACTERS);
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const LiveUpdateTimestampSchema = z.number().int().nonnegative().max(MAX_LIVE_UPDATE_TIMESTAMP_MS);
export const MAX_ENCRYPTED_MESSAGE_BASE64_CHARACTERS = Math.ceil(
  MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES / 3,
) * 4;

export function getBase64DecodedByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentEnd = value.length - padding;
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64 = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!isBase64) return null;
  }
  for (let index = contentEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }

  return (value.length / 4) * 3 - padding;
}

export function isBoundedEncryptedMessageCiphertext(value: string): boolean {
  if (value.length > MAX_ENCRYPTED_MESSAGE_BASE64_CHARACTERS) return false;
  const decodedBytes = getBase64DecodedByteLength(value);
  return decodedBytes !== null && decodedBytes <= MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES;
}

export const EncryptedMessageCiphertextSchema = z.string()
  .max(MAX_ENCRYPTED_MESSAGE_BASE64_CHARACTERS)
  .refine(isBoundedEncryptedMessageCiphertext, 'Invalid or oversized encrypted message ciphertext');

export const SessionMessageContentSchema = z.object({
  c: EncryptedMessageCiphertextSchema,
  t: z.literal('encrypted'),
});
export type SessionMessageContent = z.infer<typeof SessionMessageContentSchema>;

export const SessionMessageSchema = z.object({
  id: LiveUpdateIdSchema,
  seq: SafeNonnegativeIntegerSchema,
  localId: LiveUpdateIdSchema.nullish(),
  content: SessionMessageContentSchema,
  createdAt: LiveUpdateTimestampSchema,
  updatedAt: LiveUpdateTimestampSchema,
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export { MessageMetaSchema };
export type { MessageMeta };

export const SessionProtocolMessageSchema = z.object({
  role: z.literal('session'),
  content: sessionEnvelopeSchema,
  messageIdentity: AuthenticatedMessageIdentitySchema.optional(),
  meta: MessageMetaSchema.optional(),
});
export type SessionProtocolMessage = z.infer<typeof SessionProtocolMessageSchema>;

export const MessageContentSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AgentMessageSchema,
  SessionProtocolMessageSchema,
]);
export type MessageContent = z.infer<typeof MessageContentSchema>;

// Versions are monotonic write counters starting at 0. Negative values would
// indicate corrupt or attacker-supplied payloads (the KV path uses -1 as a
// "new key" sentinel on a SEPARATE schema in kvRoutes.ts, not this one).
export const MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS = 16 * 1024;
export const MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS = 64 * 1024;

export const VersionedEncryptedValueSchema = z.object({
  version: SafeNonnegativeIntegerSchema,
  value: z.string().max(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS),
});
export type VersionedEncryptedValue = z.infer<typeof VersionedEncryptedValueSchema>;

export const VersionedNullableEncryptedValueSchema = z.object({
  version: SafeNonnegativeIntegerSchema,
  value: z.string().max(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS).nullable(),
});
export type VersionedNullableEncryptedValue = z.infer<typeof VersionedNullableEncryptedValueSchema>;

export const UpdateNewMessageBodySchema = z.object({
  t: z.literal('new-message'),
  sid: LiveUpdateIdSchema,
  message: SessionMessageSchema,
});
export type UpdateNewMessageBody = z.infer<typeof UpdateNewMessageBodySchema>;

export const UpdateSessionBodySchema = z.object({
  t: z.literal('update-session'),
  id: LiveUpdateIdSchema,
  metadata: VersionedEncryptedValueSchema.nullish(),
  agentState: VersionedNullableEncryptedValueSchema.nullish(),
});
export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>;

export const MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS = 16 * 1024;
export const MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS = 64 * 1024;

export const VersionedMachineMetadataEncryptedValueSchema = z.object({
  version: SafeNonnegativeIntegerSchema,
  value: z.string().max(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS),
});

export const VersionedMachineEncryptedValueSchema = z.object({
  version: SafeNonnegativeIntegerSchema,
  value: z.string().max(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS),
});
export type VersionedMachineEncryptedValue = z.infer<typeof VersionedMachineEncryptedValueSchema>;

export const UpdateMachineBodySchema = z.object({
  t: z.literal('update-machine'),
  machineId: LiveUpdateIdSchema,
  metadata: VersionedMachineMetadataEncryptedValueSchema.nullish(),
  daemonState: VersionedMachineEncryptedValueSchema.nullish(),
  active: z.boolean().optional(),
  activeAt: LiveUpdateTimestampSchema.optional(),
});
export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>;

export const CoreUpdateBodySchema = z.discriminatedUnion('t', [
  UpdateNewMessageBodySchema,
  UpdateSessionBodySchema,
  UpdateMachineBodySchema,
]);
export type CoreUpdateBody = z.infer<typeof CoreUpdateBodySchema>;

export const CoreUpdateContainerSchema = z.object({
  id: LiveUpdateContainerIdSchema,
  seq: SafePositiveIntegerSchema,
  body: CoreUpdateBodySchema,
  createdAt: LiveUpdateTimestampSchema,
});
export type CoreUpdateContainer = z.infer<typeof CoreUpdateContainerSchema>;

// Aliases used by existing consumers during migration.
export const ApiMessageSchema = SessionMessageSchema;
export type ApiMessage = SessionMessage;

export const ApiUpdateNewMessageSchema = UpdateNewMessageBodySchema;
export type ApiUpdateNewMessage = UpdateNewMessageBody;

export const ApiUpdateSessionStateSchema = UpdateSessionBodySchema;
export type ApiUpdateSessionState = UpdateSessionBody;

export const ApiUpdateMachineStateSchema = UpdateMachineBodySchema;
export type ApiUpdateMachineState = UpdateMachineBody;

export const UpdateBodySchema = UpdateNewMessageBodySchema;
export type UpdateBody = UpdateNewMessageBody;

export const UpdateSchema = CoreUpdateContainerSchema;
export type Update = CoreUpdateContainer;
