import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

const POLICY_ENVIRONMENT_VARIABLE = 'IDLE_PUBLICATION_POLICY_KEY';
const POLICY_AAD = Buffer.from('idle-publication-policy/v1', 'utf8');
const POLICY_FILE = new URL('./publication-policy.encrypted.json', import.meta.url);
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_SEALED_BYTES = 64 * 1024;
const MAX_FINGERPRINTS_PER_GROUP = 1024;

export class PublicationPolicyError extends Error {
  constructor() {
    super('Private publication policy could not be authenticated');
    this.name = 'PublicationPolicyError';
  }
}

function fail() {
  throw new PublicationPolicyError();
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeDigests(value) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FINGERPRINTS_PER_GROUP ||
    value.some(candidate => typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate))
  ) {
    fail();
  }
  const unique = new Set(value);
  if (unique.size !== value.length) fail();
  return unique;
}

function normalizePolicy(value) {
  if (!hasExactKeys(value, ['opsec', 'upstream'])) fail();
  if (!hasExactKeys(value.opsec, ['caseSensitive', 'normalized'])) fail();
  if (!hasExactKeys(value.upstream, ['forbidden'])) fail();

  return Object.freeze({
    opsec: Object.freeze({
      normalized: normalizeDigests(value.opsec.normalized),
      caseSensitive: normalizeDigests(value.opsec.caseSensitive),
    }),
    upstream: Object.freeze({
      forbidden: normalizeDigests(value.upstream.forbidden),
    }),
  });
}

function normalizeEncryptedPolicy(value) {
  if (!hasExactKeys(value, ['algorithm', 'sealed', 'version'])) fail();
  if (value.version !== 1 || value.algorithm !== 'aes-256-gcm') fail();
  if (
    typeof value.sealed !== 'string' ||
    value.sealed.length === 0 ||
    value.sealed.length > Math.ceil(MAX_SEALED_BYTES / 3) * 4 ||
    !BASE64_PATTERN.test(value.sealed)
  ) {
    fail();
  }
  const combined = Buffer.from(value.sealed, 'base64');
  if (
    combined.length < 29 ||
    combined.length > MAX_SEALED_BYTES ||
    combined.toString('base64') !== value.sealed
  ) {
    combined.fill(0);
    fail();
  }
  return combined;
}

function readDefaultEncryptedPolicy() {
  let value;
  try {
    value = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  } catch {
    fail();
  }
  return value;
}

function takeKey(env) {
  let value;
  try {
    value = env?.[POLICY_ENVIRONMENT_VARIABLE];
    if (env && Object.hasOwn(env, POLICY_ENVIRONMENT_VARIABLE)) {
      delete env[POLICY_ENVIRONMENT_VARIABLE];
    }
  } catch {
    fail();
  }
  if (env && Object.hasOwn(env, POLICY_ENVIRONMENT_VARIABLE)) fail();
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) fail();
  return value;
}

export function loadPublicationPolicy({ encryptedPolicy, env = process.env, required = false } = {}) {
  if (typeof required !== 'boolean') fail();
  let keyHex = takeKey(env);
  if (keyHex === null) {
    if (required) fail();
    return null;
  }

  let combined;
  let plaintext;
  const key = Buffer.from(keyHex, 'hex');
  keyHex = null;
  try {
    combined = normalizeEncryptedPolicy(encryptedPolicy ?? readDefaultEncryptedPolicy());
    const nonce = combined.subarray(0, 12);
    const authenticationTag = combined.subarray(combined.length - 16);
    const ciphertext = combined.subarray(12, combined.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(POLICY_AAD);
    decipher.setAuthTag(authenticationTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return normalizePolicy(JSON.parse(plaintext.toString('utf8')));
  } catch {
    fail();
  } finally {
    key.fill(0);
    combined?.fill(0);
    plaintext?.fill(0);
  }
}

// Test-only sealing helper. Production policy updates use the native Keychain
// helper; this function never reads or returns that key.
export function encryptPublicationPolicyForTest(policy, keyHex) {
  if (typeof keyHex !== 'string' || !KEY_PATTERN.test(keyHex)) fail();
  const normalized = normalizePolicy(policy);
  const serializable = {
    opsec: {
      normalized: [...normalized.opsec.normalized],
      caseSensitive: [...normalized.opsec.caseSensitive],
    },
    upstream: {
      forbidden: [...normalized.upstream.forbidden],
    },
  };

  const key = Buffer.from(keyHex, 'hex');
  const nonce = randomBytes(12);
  let plaintext = Buffer.from(JSON.stringify(serializable), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(POLICY_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return Object.freeze({
      version: 1,
      algorithm: 'aes-256-gcm',
      sealed: Buffer.concat([nonce, ciphertext, authenticationTag]).toString('base64'),
    });
  } catch {
    fail();
  } finally {
    key.fill(0);
    nonce.fill(0);
    plaintext.fill(0);
    plaintext = Buffer.alloc(0);
  }
}
