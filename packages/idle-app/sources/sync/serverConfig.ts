import { MMKV } from 'react-native-mmkv';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const DEFAULT_SERVER_URL = 'https://idle-api.northglass.io';

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]') {
        return true;
    }

    const octets = normalized.split('.');
    return octets.length === 4
        && octets[0] === '127'
        && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function getServerUrl(): string {
    const candidates: unknown[] = [
        serverConfigStorage.getString(SERVER_KEY),
        (globalThis as any).__IDLE_CONFIG__?.serverUrl,
        // Read-only compatibility with older self-host server builds.
        (globalThis as any).__HAPPY_CONFIG__?.serverUrl,
        process.env.EXPO_PUBLIC_IDLE_SERVER_URL,
        DEFAULT_SERVER_URL,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const normalized = candidate.trim();
        if (validateServerUrl(normalized).valid) {
            return new URL(normalized).origin;
        }
    }

    return DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        const normalized = url.trim();
        const validation = validateServerUrl(normalized);
        if (!validation.valid) {
            throw new Error(validation.error || 'Invalid server URL');
        }
        serverConfigStorage.set(SERVER_KEY, new URL(normalized).origin);
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();

    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }

    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        if (parsed.username || parsed.password) {
            return { valid: false, error: 'Server URL must not include credentials' };
        }
        if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
            return { valid: false, error: 'Server URL must be an origin without a path, query, or fragment' };
        }
        if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
            return { valid: false, error: 'Remote server URLs must use HTTPS' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
