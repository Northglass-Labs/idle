const MAX_SERVER_URL_BYTES = 2048;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '[::1]'
  ) {
    return true;
  }

  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((part) => (
      /^\d{1,3}$/.test(part) && Number(part) <= 255
    ));
}

/**
 * Canonicalize a credential-bearing Idle relay origin.
 *
 * Public and private-network relays require TLS. Plain HTTP remains available
 * only for a client endpoint that is genuinely loopback.
 */
export function normalizeServerUrl(raw: string): string {
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw !== raw.trim()
    || new TextEncoder().encode(raw).byteLength > MAX_SERVER_URL_BYTES
  ) {
    throw new Error(
      'Idle server URL (IDLE_SERVER_URL) must be a bounded HTTP(S) server origin',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'Idle server URL (IDLE_SERVER_URL) must be an absolute HTTP(S) server origin',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Idle server URL (IDLE_SERVER_URL) must use HTTP or HTTPS',
    );
  }
  if (
    parsed.origin === 'null'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new Error(
      'Idle server URL (IDLE_SERVER_URL) must be a credential-free origin without a path, query, or fragment',
    );
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Idle server URL (IDLE_SERVER_URL) must use HTTPS unless it targets loopback',
    );
  }
  return parsed.origin;
}
