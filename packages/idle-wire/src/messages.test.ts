import { describe, expect, it } from 'vitest';
import {
    ApiUpdateMachineStateSchema,
    ApiUpdateNewMessageSchema,
    ApiUpdateSessionStateSchema,
    CoreUpdateContainerSchema,
    MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES,
    MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS,
    MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS,
    MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS,
    MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS,
  MessageContentSchema,
  SessionProtocolMessageSchema,
  VersionedEncryptedValueSchema,
  VersionedMachineEncryptedValueSchema,
  VersionedNullableEncryptedValueSchema,
} from './messages';
import {
  AgentMessageSchema,
  LegacyMessageContentSchema,
  UserMessageSchema,
} from './legacyProtocol';
import {
  AuthenticatedMessageIdentitySchema,
  createAuthenticatedMessageIdentity,
  MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS,
} from './messageIdentity';

describe('shared wire message schemas', () => {
  it('creates a bounded versioned identity for encrypted message plaintext', () => {
    expect(createAuthenticatedMessageIdentity('session-1', 'message-1')).toEqual({
      v: 1,
      sessionId: 'session-1',
      messageId: 'message-1',
    });
    expect(AuthenticatedMessageIdentitySchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      messageId: '',
    }).success).toBe(false);
    expect(AuthenticatedMessageIdentitySchema.safeParse({
      v: 1,
      sessionId: 'session-1',
      messageId: 'x'.repeat(MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS + 1),
    }).success).toBe(false);
    expect(AuthenticatedMessageIdentitySchema.safeParse({
      v: 2,
      sessionId: 'session-1',
      messageId: 'message-1',
    }).success).toBe(false);
  });

  it('accepts four decoded MiB of base64 ciphertext and rejects larger or malformed content', () => {
    const atLimit = Buffer.alloc(MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES).toString('base64');
    const oversized = Buffer.alloc(MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES + 1).toString('base64');

    const update = (content: string) => ({
      t: 'new-message' as const,
      sid: 'session-1',
      message: {
        id: 'message-1',
        seq: 1,
        localId: null,
        content: { t: 'encrypted' as const, c: content },
        createdAt: 1,
        updatedAt: 1,
      },
    });

    expect(ApiUpdateNewMessageSchema.safeParse(update(atLimit)).success).toBe(true);
    expect(ApiUpdateNewMessageSchema.safeParse(update(oversized)).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse(update('***not-base64***')).success).toBe(false);
  });

  it('parses a new-message update', () => {
    const parsed = ApiUpdateNewMessageSchema.safeParse({
      t: 'new-message',
      sid: 'session-1',
      message: {
        id: 'msg-1',
        seq: 10,
        localId: null,
        content: {
          t: 'encrypted',
          c: 'ZmFrZS1lbmNyeXB0ZWQ=',
        },
        createdAt: 123,
        updatedAt: 124,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('bounds every live message identity, counter, and timestamp', () => {
    const update = {
      t: 'new-message' as const,
      sid: 's'.repeat(64),
      message: {
        id: 'm'.repeat(64),
        seq: 1,
        localId: 'l'.repeat(64),
        content: { t: 'encrypted' as const, c: 'eA==' },
        createdAt: 1,
        updatedAt: 253_402_300_799_000,
      },
    };

    expect(ApiUpdateNewMessageSchema.safeParse(update).success).toBe(true);
    expect(ApiUpdateNewMessageSchema.safeParse({ ...update, sid: 's'.repeat(65) }).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse({
      ...update,
      message: { ...update.message, id: 'm'.repeat(65) },
    }).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse({
      ...update,
      message: { ...update.message, localId: 'l'.repeat(65) },
    }).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse({
      ...update,
      message: { ...update.message, seq: -1 },
    }).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse({
      ...update,
      message: { ...update.message, createdAt: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
    expect(ApiUpdateNewMessageSchema.safeParse({
      ...update,
      message: { ...update.message, updatedAt: 253_402_300_799_001 },
    }).success).toBe(false);
  });

  it('parses update-session with nullable agentState value', () => {
    const parsed = ApiUpdateSessionStateSchema.safeParse({
      t: 'update-session',
      id: 'session-1',
      metadata: {
        version: 2,
        value: 'abc',
      },
      agentState: {
        version: 3,
        value: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('bounds live session field ciphertext while preserving exact limits and tombstones', () => {
    const update = (metadata: string, agentState: string | null) => ({
      t: 'update-session' as const,
      id: 'session-1',
      metadata: { version: 2, value: metadata },
      agentState: { version: 3, value: agentState },
    });

    expect(ApiUpdateSessionStateSchema.safeParse(update(
      'm'.repeat(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS),
      'a'.repeat(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS),
    )).success).toBe(true);
    expect(ApiUpdateSessionStateSchema.safeParse(update(
      'm'.repeat(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS),
      null,
    )).success).toBe(true);
    expect(ApiUpdateSessionStateSchema.safeParse(update(
      'm'.repeat(MAX_SESSION_METADATA_CIPHERTEXT_CHARACTERS + 1),
      null,
    )).success).toBe(false);
    expect(ApiUpdateSessionStateSchema.safeParse(update(
      '',
      'a'.repeat(MAX_SESSION_AGENT_STATE_CIPHERTEXT_CHARACTERS + 1),
    )).success).toBe(false);
    expect(ApiUpdateSessionStateSchema.safeParse({
      ...update('', null),
      id: 's'.repeat(65),
    }).success).toBe(false);
    expect(ApiUpdateSessionStateSchema.safeParse({
      ...update('', null),
      metadata: { version: Number.MAX_SAFE_INTEGER + 1, value: '' },
    }).success).toBe(false);
  });

  it('parses update-machine with optional activity fields', () => {
    const parsed = ApiUpdateMachineStateSchema.safeParse({
      t: 'update-machine',
      machineId: 'machine-1',
      metadata: {
        version: 1,
        value: 'abc',
      },
      daemonState: {
        version: 2,
        value: 'def',
      },
      active: true,
      activeAt: 12345,
    });

    expect(parsed.success).toBe(true);
  });

  it('bounds live machine field ciphertext at the existing relay limits', () => {
    const update = (metadata: string, daemonState: string) => ({
      t: 'update-machine' as const,
      machineId: 'machine-1',
      metadata: { version: 1, value: metadata },
      daemonState: { version: 2, value: daemonState },
    });

    expect(ApiUpdateMachineStateSchema.safeParse(update(
      'm'.repeat(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS),
      'd'.repeat(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS),
    )).success).toBe(true);
    expect(ApiUpdateMachineStateSchema.safeParse(update(
      'm'.repeat(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS + 1),
      '',
    )).success).toBe(false);
    expect(ApiUpdateMachineStateSchema.safeParse(update(
      '',
      'd'.repeat(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS + 1),
    )).success).toBe(false);
    expect(ApiUpdateMachineStateSchema.safeParse({
      ...update('', ''),
      machineId: 'm'.repeat(65),
    }).success).toBe(false);
    expect(ApiUpdateMachineStateSchema.safeParse({
      ...update('', ''),
      activeAt: -1,
    }).success).toBe(false);
  });

  it('parses container updates for all shared update variants', () => {
    const examples = [
      {
        id: 'upd-1',
        seq: 1,
        body: {
          t: 'new-message',
          sid: 'session-1',
          message: {
            id: 'msg-1',
            seq: 1,
            localId: null,
            content: { t: 'encrypted', c: 'eA==' },
            createdAt: 1,
            updatedAt: 1,
          },
        },
        createdAt: 1,
      },
      {
        id: 'upd-2',
        seq: 2,
        body: {
          t: 'update-session',
          id: 'session-1',
          metadata: null,
          agentState: {
            version: 1,
            value: null,
          },
        },
        createdAt: 2,
      },
      {
        id: 'upd-3',
        seq: 3,
        body: {
          t: 'update-machine',
          machineId: 'machine-1',
          metadata: null,
          daemonState: null,
        },
        createdAt: 3,
      },
    ];

    for (const sample of examples) {
      expect(CoreUpdateContainerSchema.safeParse(sample).success).toBe(true);
    }
  });

  it('parses legacy decrypted user message payload', () => {
    const parsed = UserMessageSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'fix this test',
      },
      meta: {
        sentFrom: 'mobile',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses legacy decrypted agent message payload', () => {
    const parsed = AgentMessageSchema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'message',
          message: 'done',
        },
      },
      meta: {
        sentFrom: 'cli',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses legacy message discriminated union', () => {
    const userParsed = LegacyMessageContentSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'hello',
      },
    });
    const agentParsed = LegacyMessageContentSchema.safeParse({
      role: 'agent',
      content: {
        type: 'event',
        data: { type: 'ready' },
      },
    });

    expect(userParsed.success).toBe(true);
    expect(agentParsed.success).toBe(true);
  });

  it('parses modern session protocol wrapper payload', () => {
    const parsed = SessionProtocolMessageSchema.safeParse({
      role: 'session',
      content: {
        id: 'msg-1',
        time: 1000,
        role: 'agent',
        turn: 'turn-1',
        ev: {
          t: 'text',
          text: 'hello',
        },
      },
      meta: {
        sentFrom: 'cli',
      },
    });

    expect(parsed.success).toBe(true);
  });

  describe('MessageMeta.permissionMode accepts unknown SDK modes (P2-14)', () => {
    it('parses a known mode', () => {
      const parsed = SessionProtocolMessageSchema.safeParse({
        role: 'session',
        content: {
          id: 'msg-1', time: 1, role: 'agent', turn: 't', ev: { t: 'text', text: 'x' },
        },
        meta: { permissionMode: 'acceptEdits' },
      });
      expect(parsed.success).toBe(true);
    });

    it('parses an unknown mode without rejecting the envelope (forward compat)', () => {
      const parsed = SessionProtocolMessageSchema.safeParse({
        role: 'session',
        content: {
          id: 'msg-1', time: 1, role: 'agent', turn: 't', ev: { t: 'text', text: 'x' },
        },
        meta: { permissionMode: 'future-sdk-mode-not-yet-invented' },
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('versioned value schemas reject invalid version field (P2-13)', () => {
    it('VersionedEncryptedValueSchema rejects negative version', () => {
      const parsed = VersionedEncryptedValueSchema.safeParse({ version: -1, value: 'x' });
      expect(parsed.success).toBe(false);
    });

    it('VersionedEncryptedValueSchema rejects non-integer version', () => {
      const parsed = VersionedEncryptedValueSchema.safeParse({ version: 1.5, value: 'x' });
      expect(parsed.success).toBe(false);
    });

    it('VersionedEncryptedValueSchema accepts zero and positive integers', () => {
      expect(VersionedEncryptedValueSchema.safeParse({ version: 0, value: 'x' }).success).toBe(true);
      expect(VersionedEncryptedValueSchema.safeParse({ version: 42, value: 'x' }).success).toBe(true);
    });

    it('VersionedNullableEncryptedValueSchema rejects negative version with null value', () => {
      const parsed = VersionedNullableEncryptedValueSchema.safeParse({ version: -3, value: null });
      expect(parsed.success).toBe(false);
    });

    it('VersionedMachineEncryptedValueSchema rejects negative version', () => {
      const parsed = VersionedMachineEncryptedValueSchema.safeParse({ version: -1, value: 'x' });
      expect(parsed.success).toBe(false);
    });
  });

  it('parses top-level message discriminated union for legacy and modern roles', () => {
    const userParsed = MessageContentSchema.safeParse({
      role: 'user',
      content: {
        type: 'text',
        text: 'hello from user',
      },
    });
    const agentParsed = MessageContentSchema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'message',
          message: 'hello from agent',
        },
      },
    });
    const modernParsed = MessageContentSchema.safeParse({
      role: 'session',
      content: {
        id: 'msg-2',
        time: 2000,
        role: 'agent',
        turn: 'turn-2',
        ev: {
          t: 'text',
          text: 'hello from session protocol',
        },
      },
    });

    expect(userParsed.success).toBe(true);
    expect(agentParsed.success).toBe(true);
    expect(modernParsed.success).toBe(true);
  });
});
