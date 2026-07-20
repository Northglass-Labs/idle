export interface IdleInjectedHtmlConfig {
    serverUrl?: string;
    disableAnalytics?: boolean;
}

export function normalizeInjectedHtmlConfig(value: unknown): IdleInjectedHtmlConfig | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const normalized: IdleInjectedHtmlConfig = {};

    if (typeof candidate.serverUrl === 'string') {
        try {
            const url = new URL(candidate.serverUrl);
            const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
            const isBareOrigin = url.pathname === '/' && url.search === '' && url.hash === '';
            const hasNoCredentials = url.username === '' && url.password === '';
            if (isHttp && isBareOrigin && hasNoCredentials && url.origin !== 'null') {
                normalized.serverUrl = url.origin;
            }
        } catch {
            // Invalid URLs are omitted from the public self-host configuration.
        }
    }

    if (typeof candidate.disableAnalytics === 'boolean') {
        normalized.disableAnalytics = candidate.disableAnalytics;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function parseInjectedHtmlConfig(raw: string | undefined): IdleInjectedHtmlConfig | undefined {
    if (!raw) return undefined;
    try {
        return normalizeInjectedHtmlConfig(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

/**
 * JSON embedded in an HTML script must not contain characters that can close
 * the script element or create JavaScript line terminators in older parsers.
 * The escapes round-trip through JSON.parse without changing the value.
 */
export function serializeInlineScriptJson(value: unknown): string {
    const json = JSON.stringify(value);
    if (json === undefined) {
        throw new TypeError('Inline configuration must be JSON-serializable');
    }
    return json
        .replace(/&/g, '\\u0026')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function createInlineConfigScript(value: unknown): string | null {
    const config = normalizeInjectedHtmlConfig(value);
    if (!config) return null;
    return `<script>window.__IDLE_CONFIG__ = ${serializeInlineScriptJson(config)};</script>`;
}
