import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createInlineConfigScript } from './inlineConfig';
import {
    API_CONTENT_SECURITY_POLICY,
    contentSecurityPolicyForRequest,
    createWebContentSecurityPolicy,
    isRuntimeConfiguredHtmlResponse,
    isStaticWebRequest,
} from './contentSecurityPolicy';

describe('server-bundled web content security policy', () => {
    it('authorizes only the exact injected runtime-config script', () => {
        const script = createInlineConfigScript({
            serverUrl: 'https://relay.example.test',
            disableAnalytics: true,
        });
        expect(script).not.toBeNull();
        const source = script!.slice('<script>'.length, -'</script>'.length);
        const digest = createHash('sha256').update(source, 'utf8').digest('base64');

        const policy = createWebContentSecurityPolicy(script);

        expect(policy).toContain(`'sha256-${digest}'`);
        expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(policy).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|;|$)/);
        expect(policy).not.toMatch(/jsdelivr|fastly/i);
        // React Native Web emits dynamic style attributes; this exception is
        // intentionally isolated from the script directive.
        expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    });

    it('uses a locked policy for APIs and the web policy only for static GETs', () => {
        const script = createInlineConfigScript({ serverUrl: 'https://relay.example.test' });
        const webPolicy = createWebContentSecurityPolicy(script);

        expect(contentSecurityPolicyForRequest({
            hasStaticWebApp: true,
            method: 'GET',
            url: '/assets/app.js',
            injectScript: script,
        })).toBe(webPolicy);
        expect(contentSecurityPolicyForRequest({
            hasStaticWebApp: true,
            method: 'GET',
            url: '/settings/account',
            injectScript: script,
        })).toBe(webPolicy);

        for (const [method, url] of [
            ['GET', '/v1/account/profile'],
            ['GET', '/v2/unknown'],
            ['GET', '/v3/sessions'],
            ['GET', '/admin/unknown'],
            ['GET', '/health'],
            ['GET', '/metrics'],
            ['POST', '/settings/account'],
        ]) {
            expect(contentSecurityPolicyForRequest({
                hasStaticWebApp: true,
                method,
                url,
                injectScript: script,
            })).toBe(API_CONTENT_SECURITY_POLICY);
        }
    });

    it('keeps reserved non-web namespaces out of the SPA fallback', () => {
        expect(isStaticWebRequest({ hasStaticWebApp: true, method: 'GET', url: '/settings/account' })).toBe(true);
        for (const url of ['/admin', '/admin/unknown', '/v1/nope', '/v2/nope', '/v3/nope', '/files/x']) {
            expect(isStaticWebRequest({ hasStaticWebApp: true, method: 'GET', url })).toBe(false);
        }
        expect(isStaticWebRequest({ hasStaticWebApp: true, method: 'POST', url: '/settings/account' })).toBe(false);
    });

    it('marks only injected HTML entry responses as runtime-specific', () => {
        const script = createInlineConfigScript({ serverUrl: 'https://relay.example.test' });

        expect(isRuntimeConfiguredHtmlResponse('/', 'text/html; charset=utf-8', script)).toBe(true);
        expect(isRuntimeConfiguredHtmlResponse('/index.html?x=1', 'text/html', script)).toBe(true);
        expect(isRuntimeConfiguredHtmlResponse('/assets/app.js', 'text/javascript', script)).toBe(false);
        expect(isRuntimeConfiguredHtmlResponse('/', 'text/html', null)).toBe(false);
    });
});
