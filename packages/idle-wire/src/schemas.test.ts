import { describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';

// Import every named export so we can verify they're all reachable.
import {
  // --- sessionProtocol.ts ---
  sessionRoleSchema,
  sessionTextEventSchema,
  sessionServiceMessageEventSchema,
  sessionToolCallStartEventSchema,
  sessionToolCallEndEventSchema,
  sessionFileEventSchema,
  sessionTurnStartEventSchema,
  sessionStartEventSchema,
  sessionTurnEndStatusSchema,
  sessionTurnEndEventSchema,
  sessionStopEventSchema,
  sessionEventSchema,
  sessionEnvelopeSchema,
  createEnvelope,

  // --- legacyProtocol.ts ---
  UserMessageSchema,
  AgentMessageSchema,
  LegacyMessageContentSchema,

  // --- messageMeta.ts (re-exported via messages.ts) ---
  MessageMetaSchema,

  // --- messages.ts ---
  SessionMessageContentSchema,
  SessionMessageSchema,
  SessionProtocolMessageSchema,
  MessageContentSchema,
  VersionedEncryptedValueSchema,
  VersionedNullableEncryptedValueSchema,
  UpdateNewMessageBodySchema,
  UpdateSessionBodySchema,
  VersionedMachineEncryptedValueSchema,
  UpdateMachineBodySchema,
  CoreUpdateBodySchema,
  CoreUpdateContainerSchema,

  // Aliases
  ApiMessageSchema,
  ApiUpdateNewMessageSchema,
  ApiUpdateSessionStateSchema,
  ApiUpdateMachineStateSchema,
  UpdateBodySchema,
  UpdateSchema,
} from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid session message used in several tests. */
function validSessionMessage() {
  return {
    id: 'msg-1',
    seq: 1,
    localId: null,
    content: { t: 'encrypted' as const, c: 'Y2lwaGVydGV4dA==' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Minimal valid session envelope (agent text event). */
function validEnvelope() {
  return {
    id: 'env-1',
    time: Date.now(),
    role: 'agent' as const,
    ev: { t: 'text' as const, text: 'hello' },
  };
}

// ---------------------------------------------------------------------------
// 1. Export completeness — every named export is importable and defined
// ---------------------------------------------------------------------------

describe('export completeness', () => {
  it('all schema exports are defined', () => {
    const schemas = [
      sessionRoleSchema,
      sessionTextEventSchema,
      sessionServiceMessageEventSchema,
      sessionToolCallStartEventSchema,
      sessionToolCallEndEventSchema,
      sessionFileEventSchema,
      sessionTurnStartEventSchema,
      sessionStartEventSchema,
      sessionTurnEndStatusSchema,
      sessionTurnEndEventSchema,
      sessionStopEventSchema,
      sessionEventSchema,
      sessionEnvelopeSchema,
      UserMessageSchema,
      AgentMessageSchema,
      LegacyMessageContentSchema,
      MessageMetaSchema,
      SessionMessageContentSchema,
      SessionMessageSchema,
      SessionProtocolMessageSchema,
      MessageContentSchema,
      VersionedEncryptedValueSchema,
      VersionedNullableEncryptedValueSchema,
      UpdateNewMessageBodySchema,
      UpdateSessionBodySchema,
      VersionedMachineEncryptedValueSchema,
      UpdateMachineBodySchema,
      CoreUpdateBodySchema,
      CoreUpdateContainerSchema,
    ];

    for (const schema of schemas) {
      expect(schema).toBeDefined();
      // Every Zod schema exposes a .parse method
      expect(typeof schema.parse).toBe('function');
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('alias schemas point to the same underlying schema', () => {
    expect(ApiMessageSchema).toBe(SessionMessageSchema);
    expect(ApiUpdateNewMessageSchema).toBe(UpdateNewMessageBodySchema);
    expect(ApiUpdateSessionStateSchema).toBe(UpdateSessionBodySchema);
    expect(ApiUpdateMachineStateSchema).toBe(UpdateMachineBodySchema);
    expect(UpdateBodySchema).toBe(UpdateNewMessageBodySchema);
    expect(UpdateSchema).toBe(CoreUpdateContainerSchema);
  });

  it('createEnvelope is a function', () => {
    expect(typeof createEnvelope).toBe('function');
  });

  it('dynamic import of ./index resolves all expected keys', async () => {
    const mod = await import('./index');
    const expectedKeys = [
      // sessionProtocol
      'sessionRoleSchema',
      'sessionTextEventSchema',
      'sessionServiceMessageEventSchema',
      'sessionToolCallStartEventSchema',
      'sessionToolCallEndEventSchema',
      'sessionFileEventSchema',
      'sessionTurnStartEventSchema',
      'sessionStartEventSchema',
      'sessionTurnEndStatusSchema',
      'sessionTurnEndEventSchema',
      'sessionStopEventSchema',
      'sessionEventSchema',
      'sessionEnvelopeSchema',
      'createEnvelope',
      // legacyProtocol
      'UserMessageSchema',
      'AgentMessageSchema',
      'LegacyMessageContentSchema',
      // messageMeta
      'MessageMetaSchema',
      // messages
      'SessionMessageContentSchema',
      'SessionMessageSchema',
      'SessionProtocolMessageSchema',
      'MessageContentSchema',
      'VersionedEncryptedValueSchema',
      'VersionedNullableEncryptedValueSchema',
      'UpdateNewMessageBodySchema',
      'UpdateSessionBodySchema',
      'VersionedMachineEncryptedValueSchema',
      'UpdateMachineBodySchema',
      'CoreUpdateBodySchema',
      'CoreUpdateContainerSchema',
      // Aliases
      'ApiMessageSchema',
      'ApiUpdateNewMessageSchema',
      'ApiUpdateSessionStateSchema',
      'ApiUpdateMachineStateSchema',
      'UpdateBodySchema',
      'UpdateSchema',
    ];

    for (const key of expectedKeys) {
      expect(mod).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SessionMessageContentSchema
// ---------------------------------------------------------------------------

describe('SessionMessageContentSchema', () => {
  it('accepts valid encrypted content', () => {
    expect(SessionMessageContentSchema.parse({ c: 'YWJjMTIz', t: 'encrypted' })).toEqual({
      c: 'YWJjMTIz',
      t: 'encrypted',
    });
  });

  it('rejects missing ciphertext', () => {
    expect(SessionMessageContentSchema.safeParse({ t: 'encrypted' }).success).toBe(false);
  });

  it('rejects wrong type literal', () => {
    expect(SessionMessageContentSchema.safeParse({ c: 'abc', t: 'plaintext' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. SessionMessageSchema
// ---------------------------------------------------------------------------

describe('SessionMessageSchema', () => {
  it('accepts a full valid message', () => {
    const msg = validSessionMessage();
    const parsed = SessionMessageSchema.parse(msg);
    expect(parsed.id).toBe('msg-1');
    expect(parsed.seq).toBe(1);
    expect(parsed.content.t).toBe('encrypted');
  });

  it('accepts localId as undefined (nullish)', () => {
    const { localId: _, ...rest } = validSessionMessage();
    expect(SessionMessageSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(SessionMessageSchema.safeParse({}).success).toBe(false);
    expect(SessionMessageSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(
      SessionMessageSchema.safeParse({ id: 'x', seq: 1, content: { t: 'encrypted', c: 'y' } }).success,
    ).toBe(false); // missing timestamps
  });

  it('rejects non-numeric seq', () => {
    const msg = { ...validSessionMessage(), seq: 'not-a-number' };
    expect(SessionMessageSchema.safeParse(msg).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. MessageMetaSchema
// ---------------------------------------------------------------------------

describe('MessageMetaSchema', () => {
  it('accepts empty object (all fields optional)', () => {
    expect(MessageMetaSchema.safeParse({}).success).toBe(true);
  });

  it('accepts full metadata', () => {
    const result = MessageMetaSchema.safeParse({
      sentFrom: 'mobile',
      permissionMode: 'yolo',
      model: 'claude-opus-4-20250514',
      fallbackModel: null,
      customSystemPrompt: 'Be nice.',
      appendSystemPrompt: null,
      allowedTools: ['Read', 'Write'],
      disallowedTools: null,
      displayText: 'User sent from phone',
    });
    expect(result.success).toBe(true);
  });

  it('accepts unknown permissionMode (P2-14: forward compat with newer SDK modes)', () => {
    // The wire accepts newer provider modes so one unknown value cannot reject
    // the entire MessageMeta. Consumers clamp unknowns to a safe default.
    expect(MessageMetaSchema.safeParse({ permissionMode: 'invalid-mode' }).success).toBe(true);
    expect(MessageMetaSchema.safeParse({ permissionMode: 'future-sdk-mode' }).success).toBe(true);
  });

  it('accepts all currently-known permissionMode values', () => {
    const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo'];
    for (const mode of modes) {
      expect(MessageMetaSchema.safeParse({ permissionMode: mode }).success).toBe(true);
    }
  });

  it('still rejects non-string permissionMode (P2-14)', () => {
    expect(MessageMetaSchema.safeParse({ permissionMode: 42 }).success).toBe(false);
    expect(MessageMetaSchema.safeParse({ permissionMode: null }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. VersionedEncryptedValueSchema / VersionedNullableEncryptedValueSchema
// ---------------------------------------------------------------------------

describe('VersionedEncryptedValueSchema', () => {
  it('accepts valid versioned value', () => {
    expect(VersionedEncryptedValueSchema.parse({ version: 1, value: 'enc' })).toEqual({
      version: 1,
      value: 'enc',
    });
  });

  it('rejects null value', () => {
    expect(VersionedEncryptedValueSchema.safeParse({ version: 1, value: null }).success).toBe(false);
  });

  it('rejects missing version', () => {
    expect(VersionedEncryptedValueSchema.safeParse({ value: 'x' }).success).toBe(false);
  });
});

describe('VersionedNullableEncryptedValueSchema', () => {
  it('accepts null value', () => {
    const result = VersionedNullableEncryptedValueSchema.parse({ version: 2, value: null });
    expect(result.value).toBeNull();
  });

  it('accepts string value', () => {
    expect(VersionedNullableEncryptedValueSchema.parse({ version: 1, value: 'abc' }).value).toBe('abc');
  });

  it('rejects missing version', () => {
    expect(VersionedNullableEncryptedValueSchema.safeParse({ value: null }).success).toBe(false);
  });
});

describe('VersionedMachineEncryptedValueSchema', () => {
  it('accepts valid versioned machine value', () => {
    expect(VersionedMachineEncryptedValueSchema.parse({ version: 3, value: 'machine-enc' })).toEqual({
      version: 3,
      value: 'machine-enc',
    });
  });

  it('rejects null value (not nullable)', () => {
    expect(VersionedMachineEncryptedValueSchema.safeParse({ version: 1, value: null }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Update body schemas (discriminated union by 't')
// ---------------------------------------------------------------------------

describe('UpdateNewMessageBodySchema', () => {
  it('accepts valid new-message body', () => {
    const result = UpdateNewMessageBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess-1',
      message: validSessionMessage(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing sid', () => {
    expect(
      UpdateNewMessageBodySchema.safeParse({ t: 'new-message', message: validSessionMessage() }).success,
    ).toBe(false);
  });

  it('rejects invalid message payload', () => {
    expect(
      UpdateNewMessageBodySchema.safeParse({ t: 'new-message', sid: 's', message: {} }).success,
    ).toBe(false);
  });
});

describe('UpdateSessionBodySchema', () => {
  it('accepts minimal update-session (id only)', () => {
    expect(
      UpdateSessionBodySchema.safeParse({ t: 'update-session', id: 'sess-1' }).success,
    ).toBe(true);
  });

  it('accepts with metadata and null agentState value', () => {
    const result = UpdateSessionBodySchema.safeParse({
      t: 'update-session',
      id: 'sess-1',
      metadata: { version: 1, value: 'enc' },
      agentState: { version: 2, value: null },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    expect(UpdateSessionBodySchema.safeParse({ t: 'update-session' }).success).toBe(false);
  });
});

describe('UpdateMachineBodySchema', () => {
  it('accepts minimal update-machine', () => {
    expect(
      UpdateMachineBodySchema.safeParse({ t: 'update-machine', machineId: 'm-1' }).success,
    ).toBe(true);
  });

  it('accepts with all optional fields', () => {
    const result = UpdateMachineBodySchema.safeParse({
      t: 'update-machine',
      machineId: 'm-1',
      metadata: { version: 1, value: 'a' },
      daemonState: { version: 2, value: 'b' },
      active: true,
      activeAt: 12345,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing machineId', () => {
    expect(UpdateMachineBodySchema.safeParse({ t: 'update-machine' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. CoreUpdateBodySchema (discriminated union)
// ---------------------------------------------------------------------------

describe('CoreUpdateBodySchema', () => {
  it('routes new-message variant correctly', () => {
    const result = CoreUpdateBodySchema.safeParse({
      t: 'new-message',
      sid: 'sess-1',
      message: validSessionMessage(),
    });
    expect(result.success).toBe(true);
  });

  it('routes update-session variant correctly', () => {
    const result = CoreUpdateBodySchema.safeParse({
      t: 'update-session',
      id: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('routes update-machine variant correctly', () => {
    const result = CoreUpdateBodySchema.safeParse({
      t: 'update-machine',
      machineId: 'm-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown discriminator value', () => {
    expect(CoreUpdateBodySchema.safeParse({ t: 'delete-session', id: 'x' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. CoreUpdateContainerSchema
// ---------------------------------------------------------------------------

describe('CoreUpdateContainerSchema', () => {
  it('wraps a valid body in a container', () => {
    const container = CoreUpdateContainerSchema.parse({
      id: 'upd-1',
      seq: 1,
      body: { t: 'update-session', id: 'sess-1' },
      createdAt: Date.now(),
    });
    expect(container.id).toBe('upd-1');
    expect(container.body.t).toBe('update-session');
  });

  it('rejects missing seq', () => {
    expect(
      CoreUpdateContainerSchema.safeParse({
        id: 'upd-1',
        body: { t: 'update-session', id: 'sess-1' },
        createdAt: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects invalid body', () => {
    expect(
      CoreUpdateContainerSchema.safeParse({
        id: 'upd-1',
        seq: 1,
        body: { t: 'bogus' },
        createdAt: 1,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Session protocol event schemas
// ---------------------------------------------------------------------------

describe('sessionRoleSchema', () => {
  it('accepts user and agent', () => {
    expect(sessionRoleSchema.parse('user')).toBe('user');
    expect(sessionRoleSchema.parse('agent')).toBe('agent');
  });

  it('rejects unknown roles', () => {
    expect(sessionRoleSchema.safeParse('admin').success).toBe(false);
    expect(sessionRoleSchema.safeParse('system').success).toBe(false);
  });
});

describe('sessionTurnEndStatusSchema', () => {
  it('accepts all valid statuses', () => {
    for (const s of ['completed', 'failed', 'cancelled']) {
      expect(sessionTurnEndStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejects typo "canceled" (American spelling)', () => {
    expect(sessionTurnEndStatusSchema.safeParse('canceled').success).toBe(false);
  });
});

describe('individual session event schemas', () => {
  it('sessionTextEventSchema accepts thinking flag', () => {
    expect(sessionTextEventSchema.parse({ t: 'text', text: 'hi', thinking: true }).thinking).toBe(true);
  });

  it('sessionTextEventSchema rejects missing text', () => {
    expect(sessionTextEventSchema.safeParse({ t: 'text' }).success).toBe(false);
  });

  it('sessionServiceMessageEventSchema accepts valid service event', () => {
    expect(sessionServiceMessageEventSchema.parse({ t: 'service', text: 'info' }).text).toBe('info');
  });

  it('sessionToolCallStartEventSchema requires all fields', () => {
    // Missing name, title, description, args
    expect(sessionToolCallStartEventSchema.safeParse({ t: 'tool-call-start', call: 'c1' }).success).toBe(false);
  });

  it('sessionToolCallStartEventSchema accepts valid payload', () => {
    const result = sessionToolCallStartEventSchema.safeParse({
      t: 'tool-call-start',
      call: 'c1',
      name: 'Bash',
      title: 'Run command',
      description: 'Execute ls',
      args: { command: 'ls' },
    });
    expect(result.success).toBe(true);
  });

  it('sessionToolCallEndEventSchema accepts valid payload', () => {
    expect(sessionToolCallEndEventSchema.parse({ t: 'tool-call-end', call: 'c1' }).call).toBe('c1');
  });

  it('sessionFileEventSchema rejects incomplete image metadata', () => {
    // image missing thumbhash
    expect(
      sessionFileEventSchema.safeParse({
        t: 'file',
        ref: 'r1',
        name: 'pic.png',
        size: 100,
        image: { width: 10, height: 10 },
      }).success,
    ).toBe(false);
  });

  it('sessionFileEventSchema accepts file without image', () => {
    expect(
      sessionFileEventSchema.safeParse({ t: 'file', ref: 'r1', name: 'doc.txt', size: 50 }).success,
    ).toBe(true);
  });

  it('sessionTurnStartEventSchema accepts minimal payload', () => {
    expect(sessionTurnStartEventSchema.parse({ t: 'turn-start' })).toEqual({ t: 'turn-start' });
  });

  it('sessionStartEventSchema accepts optional title', () => {
    expect(sessionStartEventSchema.parse({ t: 'start' })).toEqual({ t: 'start' });
    expect(sessionStartEventSchema.parse({ t: 'start', title: 'Agent' }).title).toBe('Agent');
  });

  it('sessionTurnEndEventSchema requires status', () => {
    expect(sessionTurnEndEventSchema.safeParse({ t: 'turn-end' }).success).toBe(false);
  });

  it('sessionStopEventSchema accepts minimal payload', () => {
    expect(sessionStopEventSchema.parse({ t: 'stop' })).toEqual({ t: 'stop' });
  });
});

// ---------------------------------------------------------------------------
// 10. sessionEnvelopeSchema — cross-field refinements
// ---------------------------------------------------------------------------

describe('sessionEnvelopeSchema refinements', () => {
  it('accepts agent text envelope', () => {
    expect(sessionEnvelopeSchema.safeParse(validEnvelope()).success).toBe(true);
  });

  it('accepts user text envelope', () => {
    const env = { ...validEnvelope(), role: 'user' as const };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('rejects service event from user role', () => {
    const env = {
      ...validEnvelope(),
      role: 'user' as const,
      ev: { t: 'service' as const, text: 'oops' },
    };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it('rejects start event from user role', () => {
    const env = {
      ...validEnvelope(),
      role: 'user' as const,
      ev: { t: 'start' as const },
    };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it('rejects stop event from user role', () => {
    const env = {
      ...validEnvelope(),
      role: 'user' as const,
      ev: { t: 'stop' as const },
    };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it('accepts valid cuid2 subagent', () => {
    const subagent = createId();
    const env = { ...validEnvelope(), subagent };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('rejects non-cuid2 subagent string', () => {
    const env = { ...validEnvelope(), subagent: 'not-a-cuid' };
    expect(sessionEnvelopeSchema.safeParse(env).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. Legacy protocol schemas
// ---------------------------------------------------------------------------

describe('UserMessageSchema', () => {
  it('accepts valid user message', () => {
    const result = UserMessageSchema.safeParse({
      role: 'user',
      content: { type: 'text', text: 'hello' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional meta and localKey', () => {
    const result = UserMessageSchema.safeParse({
      role: 'user',
      content: { type: 'text', text: 'hello' },
      localKey: 'key-1',
      meta: { sentFrom: 'mobile' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects wrong role', () => {
    expect(
      UserMessageSchema.safeParse({ role: 'agent', content: { type: 'text', text: 'hi' } }).success,
    ).toBe(false);
  });

  it('rejects wrong content type', () => {
    expect(
      UserMessageSchema.safeParse({ role: 'user', content: { type: 'image', url: 'x' } }).success,
    ).toBe(false);
  });
});

describe('AgentMessageSchema', () => {
  it('accepts agent message with passthrough fields', () => {
    const result = AgentMessageSchema.safeParse({
      role: 'agent',
      content: { type: 'output', data: { type: 'message', message: 'done' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // passthrough should preserve extra fields
      expect((result.data.content as Record<string, unknown>).data).toBeDefined();
    }
  });

  it('rejects wrong role', () => {
    expect(
      AgentMessageSchema.safeParse({ role: 'user', content: { type: 'output' } }).success,
    ).toBe(false);
  });
});

describe('LegacyMessageContentSchema', () => {
  it('discriminates by role', () => {
    expect(
      LegacyMessageContentSchema.safeParse({ role: 'user', content: { type: 'text', text: 'hi' } }).success,
    ).toBe(true);
    expect(
      LegacyMessageContentSchema.safeParse({ role: 'agent', content: { type: 'event' } }).success,
    ).toBe(true);
  });

  it('rejects session role (not part of legacy)', () => {
    expect(
      LegacyMessageContentSchema.safeParse({
        role: 'session',
        content: validEnvelope(),
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. MessageContentSchema (top-level union: user | agent | session)
// ---------------------------------------------------------------------------

describe('MessageContentSchema', () => {
  it('accepts all three roles', () => {
    expect(
      MessageContentSchema.safeParse({ role: 'user', content: { type: 'text', text: 'hi' } }).success,
    ).toBe(true);
    expect(
      MessageContentSchema.safeParse({ role: 'agent', content: { type: 'output' } }).success,
    ).toBe(true);
    expect(
      MessageContentSchema.safeParse({
        role: 'session',
        content: validEnvelope(),
      }).success,
    ).toBe(true);
  });

  it('rejects unknown role', () => {
    expect(
      MessageContentSchema.safeParse({ role: 'system', content: {} }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. SessionProtocolMessageSchema
// ---------------------------------------------------------------------------

describe('SessionProtocolMessageSchema', () => {
  it('accepts valid session protocol message with meta', () => {
    const result = SessionProtocolMessageSchema.safeParse({
      role: 'session',
      content: validEnvelope(),
      meta: { sentFrom: 'cli', permissionMode: 'default' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts without meta', () => {
    expect(
      SessionProtocolMessageSchema.safeParse({
        role: 'session',
        content: validEnvelope(),
      }).success,
    ).toBe(true);
  });

  it('rejects wrong role literal', () => {
    expect(
      SessionProtocolMessageSchema.safeParse({
        role: 'user',
        content: validEnvelope(),
      }).success,
    ).toBe(false);
  });

  it('rejects invalid envelope content', () => {
    expect(
      SessionProtocolMessageSchema.safeParse({
        role: 'session',
        content: { id: 'x' }, // missing required fields
      }).success,
    ).toBe(false);
  });
});
