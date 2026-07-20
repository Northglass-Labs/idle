import { describe, expect, it } from 'vitest';
import { CreateSessionResponseSchema, SessionRecordSchema } from './sessionRecord';

const validSession = {
  id: '11111111-1111-4111-8111-111111111111',
  seq: 0,
  createdAt: 1,
  updatedAt: 1,
  active: true,
  activeAt: 1,
  metadata: 'encrypted-metadata',
  metadataVersion: 0,
  agentState: null,
  agentStateVersion: 0,
  dataEncryptionKey: 'wrapped-key',
  lastMessage: null,
};

describe('SessionRecordSchema', () => {
  it('accepts the bounded relay record contract', () => {
    expect(SessionRecordSchema.parse(validSession)).toEqual(validSession);
    expect(CreateSessionResponseSchema.parse({ session: validSession })).toEqual({
      session: validSession,
    });
  });

  it.each([
    ['oversized ID', { id: 'x'.repeat(65) }],
    ['unsafe sequence', { seq: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative timestamp', { updatedAt: -1 }],
    ['oversized metadata', { metadata: 'x'.repeat((16 * 1024) + 1) }],
    ['oversized agent state', { agentState: 'x'.repeat((64 * 1024) + 1) }],
    ['oversized wrapped key', { dataEncryptionKey: 'x'.repeat(1025) }],
  ])('rejects an invalid %s', (_label, invalidFields) => {
    expect(SessionRecordSchema.safeParse({
      ...validSession,
      ...invalidFields,
    }).success).toBe(false);
  });
});
