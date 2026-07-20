/**
 * OpenClaw Device Identity & Authentication
 *
 * Manages Ed25519 device identity for secure gateway authentication.
 * Ported from expo-app/sources/clawdbot/deviceIdentity.ts for Node.js,
 * using filesystem storage instead of expo-secure-store.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { normalizeOpenClawGatewayOrigin } from './openclawGateway';

// @noble/ed25519 v3 requires explicit SHA-512 configuration via hashes object
ed.hashes.sha512 = (message: Uint8Array) => sha512(message);

const { getPublicKeyAsync, signAsync, utils } = ed;

const OPENCLAW_DIR_NAME = 'openclaw';
const DEVICE_IDENTITY_FILE = 'device-identity.json';
const DEVICE_AUTH_TOKEN_FILE = 'device-auth-token.json';

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

interface StoredDeviceIdentity {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
}

export interface StoredDeviceAuthToken {
  version: 2;
  gatewayOrigin: string;
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
}

const identityCache = new Map<string, DeviceIdentity>();
const authTokenCache = new Map<string, StoredDeviceAuthToken | null>();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getOpenClawDir(homeDir: string): string {
  return join(homeDir, OPENCLAW_DIR_NAME);
}

function ensureDir(dir: string): void {
  if (existsSync(dir)) {
    const stats = lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('OpenClaw credential path is not a private directory');
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    ensureDir(dirname(filePath));
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    chmodSync(filePath, 0o600);
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  ensureDir(dir);
  const tempPath = join(dir, `.${randomBytes(16).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function deleteFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update(publicKey).digest();
  return bytesToHex(new Uint8Array(hash));
}

async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

export async function loadOrCreateDeviceIdentity(homeDir: string): Promise<DeviceIdentity> {
  const filePath = join(getOpenClawDir(homeDir), DEVICE_IDENTITY_FILE);
  const cached = identityCache.get(filePath);
  if (cached) return cached;
  const stored = readJsonFile<StoredDeviceIdentity>(filePath);

  if (stored?.version === 1 && typeof stored.publicKey === 'string' && typeof stored.privateKey === 'string') {
    const derivedId = fingerprintPublicKey(base64UrlDecode(stored.publicKey));
    if (derivedId !== stored.deviceId) {
      const updated: StoredDeviceIdentity = { ...stored, deviceId: derivedId };
      writeJsonFile(filePath, updated);
    }
    const identity = {
      deviceId: derivedId,
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
    };
    identityCache.set(filePath, identity);
    return identity;
  }

  const identity = await generateDeviceIdentity();
  const toStore: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  writeJsonFile(filePath, toStore);
  identityCache.set(filePath, identity);
  return identity;
}

export async function loadDeviceAuthToken(homeDir: string, gatewayUrl: string): Promise<StoredDeviceAuthToken | null> {
  const gatewayOrigin = normalizeOpenClawGatewayOrigin(gatewayUrl);
  const filePath = join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE);
  const cacheKey = `${filePath}\0${gatewayOrigin}`;
  if (authTokenCache.has(cacheKey)) return authTokenCache.get(cacheKey) ?? null;

  const stored = readJsonFile<Partial<StoredDeviceAuthToken>>(filePath);
  if (!stored) {
    authTokenCache.set(cacheKey, null);
    return null;
  }
  if (
    stored.version !== 2
    || typeof stored.gatewayOrigin !== 'string'
    || typeof stored.token !== 'string'
    || typeof stored.role !== 'string'
    || !Array.isArray(stored.scopes)
    || !stored.scopes.every((scope) => typeof scope === 'string')
  ) {
    deleteFile(filePath);
    authTokenCache.clear();
    return null;
  }
  if (stored.gatewayOrigin !== gatewayOrigin) {
    authTokenCache.set(cacheKey, null);
    return null;
  }

  const token = stored as StoredDeviceAuthToken;
  authTokenCache.set(cacheKey, token);
  return token;
}

export async function storeDeviceAuthToken(
  homeDir: string,
  gatewayUrl: string,
  params: { token: string; role: string; scopes: string[] },
): Promise<void> {
  const gatewayOrigin = normalizeOpenClawGatewayOrigin(gatewayUrl);
  const stored: StoredDeviceAuthToken = {
    version: 2,
    gatewayOrigin,
    token: params.token,
    role: params.role,
    scopes: params.scopes,
    createdAtMs: Date.now(),
  };
  const filePath = join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE);
  writeJsonFile(filePath, stored);
  authTokenCache.clear();
  authTokenCache.set(`${filePath}\0${gatewayOrigin}`, stored);
}

export async function clearDeviceIdentity(homeDir: string): Promise<void> {
  identityCache.clear();
  authTokenCache.clear();
  deleteFile(join(getOpenClawDir(homeDir), DEVICE_IDENTITY_FILE));
  deleteFile(join(getOpenClawDir(homeDir), DEVICE_AUTH_TOKEN_FILE));
}

export function resetIdentityCache(): void {
  identityCache.clear();
  authTokenCache.clear();
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  return ['v2', params.deviceId, params.clientId, params.clientMode, params.role, scopes, String(params.signedAtMs), token, params.nonce].join('|');
}

export async function signPayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
