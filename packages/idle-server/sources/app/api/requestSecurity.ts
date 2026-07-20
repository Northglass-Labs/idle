import { isIP } from 'node:net';
import { MAX_MESSAGE_INGRESS_BODY_BYTES } from '@northglass/idle-wire';

export const GLOBAL_BODY_LIMIT = 1024 * 1024;
export const ATTACHMENT_BODY_LIMIT = 10 * 1024 * 1024;

// Large encrypted messages are split by official clients. The route reserves
// this entire amount before parsing because Content-Length is attacker input.
export const AUTHENTICATED_MESSAGE_BODY_LIMIT = MAX_MESSAGE_INGRESS_BODY_BYTES;

const DEFAULT_ALLOWED_ORIGINS = [
    'https://idle.northglass.io',
    'http://localhost:8081',
    'http://localhost:19006',
] as const;

type RateLimitRequest = { ip?: string };

/**
 * Fastify derives `request.ip` from the transport peer and only the explicitly
 * trusted loopback reverse proxy. Raw CDN headers are client input when the
 * origin is reached directly, so they must never select a limiter bucket.
 */
export function getGlobalRateLimitKey(request: RateLimitRequest): string {
    return request.ip || 'unknown';
}

type SocketPeer = {
    address?: string;
    headers?: Record<string, string | string[] | undefined>;
};

/**
 * Use the transport peer directly, except for the same trusted loopback nginx
 * hop used by Fastify. nginx appends the real peer to X-Forwarded-For, so the
 * rightmost valid address is not affected by earlier client-spoofed entries.
 */
export function getSocketRateLimitKey(peer: SocketPeer): string {
    const address = peer.address || 'unknown';
    const isLoopback = address === '127.0.0.1'
        || address === '::1'
        || address === '::ffff:127.0.0.1';
    if (!isLoopback) return address;

    const forwarded = peer.headers?.['x-forwarded-for'];
    const text = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const candidates = typeof text === 'string'
        ? text.split(',').map(value => value.trim()).filter(value => isIP(value) !== 0)
        : [];
    return candidates.at(-1) ?? address;
}

/**
 * Add one operator-configured browser origin. The value must already be a
 * canonical HTTPS origin: no wildcard, credentials, path, query, or fragment.
 */
export function resolveAllowedOrigins(configuredOrigin = process.env.IDLE_CORS_ORIGIN): string[] {
    const origins: string[] = [...DEFAULT_ALLOWED_ORIGINS];
    if (configuredOrigin === undefined || configuredOrigin === '') return origins;

    let parsed: URL;
    try {
        parsed = new URL(configuredOrigin);
    } catch {
        throw new Error('IDLE_CORS_ORIGIN must be an exact HTTPS origin');
    }
    if (
        parsed.protocol !== 'https:' ||
        configuredOrigin.includes('*') ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.origin !== configuredOrigin
    ) {
        throw new Error('IDLE_CORS_ORIGIN must be an exact HTTPS origin');
    }

    if (!origins.includes(configuredOrigin)) {
        origins.push(configuredOrigin);
    }
    return origins;
}
