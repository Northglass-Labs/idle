import { describe, expect, it } from 'vitest';
import { decryptSessionField, encryptSessionField } from './sessionFieldEncryption';
import { encodeBase64, encrypt } from './encryption';

describe('session field authenticated encryption', () => {
  it('allows raw legacy data only when the initial-sync compatibility flag is explicit', () => {
    const encryption = { key: new Uint8Array(32).fill(4), variant: 'legacy' as const };
    const raw = encodeBase64(encrypt(
      encryption.key,
      encryption.variant,
      { path: '/legacy', host: 'old-client' },
    ));

    expect(decryptSessionField(
      encryption,
      'session-a',
      'metadata',
      1,
      raw,
    )).toEqual({ success: false });
    expect(decryptSessionField(
      encryption,
      'session-a',
      'metadata',
      1,
      raw,
      { allowLegacy: true },
    )).toEqual({
      success: true,
      value: { path: '/legacy', host: 'old-client' },
      binding: 'legacy',
    });
  });

  for (const variant of ['legacy', 'dataKey'] as const) {
    it(`binds ${variant} ciphertext to its session, field, and version`, () => {
      const encryption = { key: new Uint8Array(32).fill(9), variant };
      const ciphertext = encryptSessionField(
        encryption,
        'session-a',
        'agentState',
        1,
        { controlledByUser: false },
      );

      expect(decryptSessionField(
        encryption,
        'session-a',
        'agentState',
        1,
        ciphertext,
      )).toEqual({
        success: true,
        value: { controlledByUser: false },
        binding: 'bound',
      });
      expect(decryptSessionField(
        encryption,
        'session-a',
        'agentState',
        999,
        ciphertext,
      )).toEqual({ success: false });
      expect(decryptSessionField(
        encryption,
        'session-b',
        'agentState',
        1,
        ciphertext,
      )).toEqual({ success: false });
      expect(decryptSessionField(
        encryption,
        'session-a',
        'metadata',
        1,
        ciphertext,
      )).toEqual({ success: false });
    });
  }
});
