import { createHash } from 'node:crypto';

export const API_CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
].join('; ');

function inlineScriptHash(scriptTag: string): string {
    const openingTag = '<script>';
    const closingTag = '</script>';
    if (!scriptTag.startsWith(openingTag) || !scriptTag.endsWith(closingTag)) {
        throw new Error('Injected web configuration must be one inline script');
    }
    const source = scriptTag.slice(openingTag.length, -closingTag.length);
    if (source.includes(openingTag) || source.includes(closingTag)) {
        throw new Error('Injected web configuration must be one inline script');
    }
    return createHash('sha256').update(source, 'utf8').digest('base64');
}

export function createWebContentSecurityPolicy(injectScript: string | null): string {
    const configHash = injectScript ? ` 'sha256-${inlineScriptHash(injectScript)}'` : '';
    return [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "manifest-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval'${configHash} https://js.stripe.com https://cdn.paddle.com`,
        // Expo and React Native Web emit runtime style attributes. Keep this
        // exception isolated from scripts, which remain hash/source restricted.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https: http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:*",
        "font-src 'self' data:",
        "connect-src 'self' https: wss: http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://*.localhost:* ws://127.0.0.1:* ws://[::1]:*",
        "worker-src 'self' blob:",
        "child-src 'self' blob: https://js.stripe.com https://*.stripe.com https://*.stripe.network https://*.paddle.com https://*.revenuecat.com",
        "frame-src 'self' blob: https://js.stripe.com https://*.stripe.com https://*.stripe.network https://*.paddle.com https://*.revenuecat.com",
        "media-src 'self' data: blob: https: http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:*",
    ].join('; ');
}

const NON_WEB_PREFIXES = [
    '/admin',
    '/files/',
    '/health',
    '/metrics',
    '/socket',
    '/v1',
    '/v2',
    '/v3',
];

export function isStaticWebRequest(options: {
    hasStaticWebApp: boolean;
    method: string;
    url: string;
}): boolean {
    const pathname = options.url.split(/[?#]/, 1)[0];
    const hasReservedPrefix = NON_WEB_PREFIXES.some((prefix) => (
        prefix.endsWith('/')
            ? pathname.startsWith(prefix)
            : pathname === prefix || pathname.startsWith(`${prefix}/`)
    ));
    return options.hasStaticWebApp
        && (options.method === 'GET' || options.method === 'HEAD')
        && !hasReservedPrefix;
}

export function contentSecurityPolicyForRequest(options: {
    hasStaticWebApp: boolean;
    method: string;
    url: string;
    injectScript: string | null;
}): string {
    return isStaticWebRequest(options)
        ? createWebContentSecurityPolicy(options.injectScript)
        : API_CONTENT_SECURITY_POLICY;
}

export function isRuntimeConfiguredHtmlResponse(
    url: string,
    contentType: string | number | string[] | undefined,
    injectScript: string | null,
): boolean {
    if (!injectScript || typeof contentType !== 'string' || !contentType.includes('text/html')) {
        return false;
    }
    const pathname = url.split(/[?#]/, 1)[0];
    return pathname === '/' || pathname === '/index.html';
}
