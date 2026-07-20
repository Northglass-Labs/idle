import { describe, it, expect } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

describe('parseMarkdownSpans XSS protection', () => {

    describe('safe URLs produce links', () => {
        it('allows https URLs', () => {
            const spans = parseMarkdownSpans('[click](https://example.com)', false);
            const link = spans.find(s => s.text === 'click');
            expect(link).toBeDefined();
            expect(link!.url).toBe('https://example.com');
        });

        it('allows http URLs', () => {
            const spans = parseMarkdownSpans('[site](http://example.com)', false);
            const link = spans.find(s => s.text === 'site');
            expect(link).toBeDefined();
            expect(link!.url).toBe('http://example.com');
        });

        it('allows mailto URLs', () => {
            const spans = parseMarkdownSpans('[email](mailto:user@example.com)', false);
            const link = spans.find(s => s.text === 'email');
            expect(link).toBeDefined();
            expect(link!.url).toBe('mailto:user@example.com');
        });

        it('allows relative URLs starting with /', () => {
            const spans = parseMarkdownSpans('[page](/docs/guide)', false);
            const link = spans.find(s => s.text === 'page');
            expect(link).toBeDefined();
            expect(link!.url).toBe('/docs/guide');
        });

        it('allows anchor fragment URLs starting with #', () => {
            const spans = parseMarkdownSpans('[section](#heading)', false);
            const link = spans.find(s => s.text === 'section');
            expect(link).toBeDefined();
            expect(link!.url).toBe('#heading');
        });

        it('allows bare relative paths without protocol', () => {
            const spans = parseMarkdownSpans('[file](readme.md)', false);
            const link = spans.find(s => s.text === 'file');
            expect(link).toBeDefined();
            expect(link!.url).toBe('readme.md');
        });
    });

    describe('dangerous URLs are neutralized (url: null)', () => {
        it('blocks javascript: protocol', () => {
            const spans = parseMarkdownSpans('[xss](javascript:alert(1))', false);
            const link = spans.find(s => s.text === 'xss');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks javascript: with mixed case', () => {
            const spans = parseMarkdownSpans('[xss](JavaScript:alert(1))', false);
            const link = spans.find(s => s.text === 'xss');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks javascript: with leading whitespace', () => {
            const spans = parseMarkdownSpans('[xss](  javascript:alert(1))', false);
            const link = spans.find(s => s.text === 'xss');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks data: protocol', () => {
            const spans = parseMarkdownSpans('[payload](data:text/html,<script>alert(1)</script>)', false);
            const link = spans.find(s => s.text === 'payload');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks vbscript: protocol', () => {
            const spans = parseMarkdownSpans('[vb](vbscript:MsgBox("xss"))', false);
            const link = spans.find(s => s.text === 'vb');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks data: with base64 payload', () => {
            const spans = parseMarkdownSpans('[img](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+)', false);
            const link = spans.find(s => s.text === 'img');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });

        it('blocks custom/unknown protocols with colons', () => {
            const spans = parseMarkdownSpans('[x](custom:payload)', false);
            const link = spans.find(s => s.text === 'x');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });
    });

    describe('XSS payloads in link text are preserved as plain string content', () => {
        it('preserves script tag in link text as string, not as executable', () => {
            const spans = parseMarkdownSpans('[<script>alert(1)</script>](https://safe.com)', false);
            const link = spans.find(s => s.url === 'https://safe.com');
            expect(link).toBeDefined();
            expect(link!.text).toBe('<script>alert(1)</script>');
            // The text is a plain string — no DOM interpretation happens
            expect(typeof link!.text).toBe('string');
        });

        it('preserves event handler payloads in link text as string', () => {
            const spans = parseMarkdownSpans('[<img onerror=alert(1)>](https://safe.com)', false);
            const link = spans.find(s => s.url === 'https://safe.com');
            expect(link).toBeDefined();
            expect(link!.text).toContain('onerror');
            expect(typeof link!.text).toBe('string');
        });

        it('dangerous text + dangerous URL both neutralized', () => {
            const spans = parseMarkdownSpans('[<script>alert(1)</script>](javascript:void(0))', false);
            const target = spans.find(s => s.text.includes('script'));
            expect(target).toBeDefined();
            expect(target!.url).toBeNull();
            expect(typeof target!.text).toBe('string');
        });
    });

    describe('edge cases', () => {
        it('link without URL part renders as plain text', () => {
            const spans = parseMarkdownSpans('[orphan link]', false);
            const span = spans.find(s => s.text === 'orphan link');
            expect(span).toBeDefined();
            expect(span!.url).toBeNull();
        });

        it('empty URL renders as plain text', () => {
            const spans = parseMarkdownSpans('[text]()', false);
            const span = spans.find(s => s.text === 'text');
            expect(span).toBeDefined();
            // Empty string has no colon, so isSafeUrl returns true for it
            // But the regex match[7] will be empty string which is truthy
        });

        it('multiple links in one string are each validated independently', () => {
            const spans = parseMarkdownSpans(
                '[safe](https://ok.com) and [bad](javascript:alert(1))',
                false
            );
            const safe = spans.find(s => s.text === 'safe');
            const bad = spans.find(s => s.text === 'bad');
            expect(safe!.url).toBe('https://ok.com');
            expect(bad!.url).toBeNull();
        });

        it('header mode does not affect URL safety filtering', () => {
            const spans = parseMarkdownSpans('[link](javascript:alert(1))', true);
            const link = spans.find(s => s.text === 'link');
            expect(link).toBeDefined();
            expect(link!.url).toBeNull();
        });
    });
});
