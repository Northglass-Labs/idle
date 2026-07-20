import {
  createAuthenticatedSessionFieldEnvelope,
  isAuthenticatedSessionFieldEnvelopeCandidate,
  readAuthenticatedSessionFieldEnvelope,
  type AuthenticatedSessionFieldName,
} from '@northglass/idle-wire';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';

export type SessionFieldEncryption = {
  key: Uint8Array;
  variant: 'legacy' | 'dataKey';
};

export type SessionFieldDecryptionResult<T extends Record<string, unknown>> =
  | { success: true; value: T; binding: 'bound' | 'legacy' }
  | { success: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function encryptSessionField(
  encryption: SessionFieldEncryption,
  sessionId: string,
  field: AuthenticatedSessionFieldName,
  version: number,
  value: Record<string, unknown>,
): string {
  const envelope = createAuthenticatedSessionFieldEnvelope(
    sessionId,
    field,
    version,
    value,
  );
  return encodeBase64(encrypt(encryption.key, encryption.variant, envelope));
}

export function decryptSessionField<T extends Record<string, unknown>>(
  encryption: SessionFieldEncryption,
  sessionId: string,
  field: AuthenticatedSessionFieldName,
  version: number,
  ciphertext: string | null | undefined,
  options: { allowLegacy?: boolean } = {},
): SessionFieldDecryptionResult<T> {
  if (!ciphertext) {
    return { success: false };
  }

  let plaintext: unknown;
  try {
    plaintext = decrypt(
      encryption.key,
      encryption.variant,
      decodeBase64(ciphertext),
    );
  } catch {
    return { success: false };
  }
  if (!isRecord(plaintext)) {
    return { success: false };
  }

  const bound = readAuthenticatedSessionFieldEnvelope(plaintext, {
    sessionId,
    field,
    version,
  });
  if (bound.success) {
    return { success: true, value: bound.value as T, binding: 'bound' };
  }
  if (!options.allowLegacy || isAuthenticatedSessionFieldEnvelopeCandidate(plaintext)) {
    return { success: false };
  }
  return { success: true, value: plaintext as T, binding: 'legacy' };
}
