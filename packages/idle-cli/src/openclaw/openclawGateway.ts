import { isIP } from 'node:net';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}

export function assertSafeOpenClawGatewayUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('OpenClaw gateway URL is invalid');
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('OpenClaw gateway URL must use ws:// or wss://');
  }
  if (url.username || url.password) {
    throw new Error('OpenClaw gateway URL must not contain credentials');
  }
  if (url.hash) {
    throw new Error('OpenClaw gateway URL must not contain a fragment');
  }
  if (url.protocol === 'ws:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('OpenClaw gateway requires wss:// unless it is on loopback');
  }

  return url;
}

export function normalizeOpenClawGatewayOrigin(rawUrl: string): string {
  return assertSafeOpenClawGatewayUrl(rawUrl).origin;
}

export function canUseAutoDetectedOpenClawToken(selectedUrl: string, detectedUrl: string): boolean {
  try {
    return normalizeOpenClawGatewayOrigin(selectedUrl) === normalizeOpenClawGatewayOrigin(detectedUrl);
  } catch {
    return false;
  }
}
