import { describe, expect, it } from 'vitest';
import {
    createInlineConfigScript,
    normalizeInjectedHtmlConfig,
    parseInjectedHtmlConfig,
    serializeInlineScriptJson,
} from './inlineConfig';

describe('self-host inline configuration security', () => {
    it('serializes hostile text without creating an attacker-controlled script boundary', () => {
        const hostile = '</script><script>globalThis.pwned=true</script>&\u2028\u2029>';
        const serialized = serializeInlineScriptJson({ hostile });

        expect(serialized).not.toContain('<');
        expect(serialized).not.toContain('>');
        expect(serialized).not.toContain('&');
        expect(serialized).not.toContain('\u2028');
        expect(serialized).not.toContain('\u2029');
        expect(JSON.parse(serialized)).toEqual({ hostile });
        expect(() => serializeInlineScriptJson(undefined)).toThrow(/JSON-serializable/);
    });

    it('serves one inert script with the same normalized config the app reads', () => {
        const script = createInlineConfigScript({
            serverUrl: 'https://idle.example.test/',
            disableAnalytics: true,
            injected: '</script><script>globalThis.pwned=true</script>',
        });

        expect(script).not.toBeNull();
        expect(script!.match(/<\/script>/g)).toHaveLength(1);
        expect(script).not.toContain('globalThis.pwned');

        const prefix = '<script>window.__IDLE_CONFIG__ = ';
        const suffix = ';</script>';
        const serialized = script!.slice(prefix.length, -suffix.length);
        expect(JSON.parse(serialized)).toEqual({
            serverUrl: 'https://idle.example.test',
            disableAnalytics: true,
        });
    });

    it('allows only a bare http/https origin and a boolean analytics flag', () => {
        expect(normalizeInjectedHtmlConfig({
            serverUrl: 'http://127.0.0.1:4505/',
            disableAnalytics: false,
            unknown: 'strip me',
        })).toEqual({ serverUrl: 'http://127.0.0.1:4505', disableAnalytics: false });

        for (const serverUrl of [
            'javascript:alert(1)',
            'file:///tmp/idle',
            ['https://user', ':pass@example.test'].join(''),
            'https://example.test/path',
            'https://example.test/?query=1',
            'https://example.test/#fragment',
        ]) {
            expect(normalizeInjectedHtmlConfig({ serverUrl })).toBeUndefined();
        }
        expect(normalizeInjectedHtmlConfig({ disableAnalytics: 'true' })).toBeUndefined();
        expect(normalizeInjectedHtmlConfig(['https://example.test'])).toBeUndefined();
    });

    it('treats malformed environment JSON as absent and strips unknown properties', () => {
        expect(parseInjectedHtmlConfig('{not-json')).toBeUndefined();
        expect(parseInjectedHtmlConfig(JSON.stringify({
            serverUrl: 'http://localhost:3005',
            disableAnalytics: true,
            payload: '</script><script>alert(1)</script>',
        }))).toEqual({ serverUrl: 'http://localhost:3005', disableAnalytics: true });
    });
});
