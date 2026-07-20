import { describe, expect, it } from 'vitest';
import { classifyMarkdownImage, getMarkdownImageRenderUri } from './imagePolicy';

describe('classifyMarkdownImage', () => {
    it('requires an explicit user action before an HTTPS image may load', () => {
        const policy = classifyMarkdownImage('https://tracker.example/pixel.png?id=unique');

        expect(policy).toEqual({
            kind: 'remote',
            hostname: 'tracker.example',
            uri: 'https://tracker.example/pixel.png?id=unique',
        });
        expect(getMarkdownImageRenderUri(policy, false)).toBeNull();
        expect(getMarkdownImageRenderUri(policy, true)).toBe('https://tracker.example/pixel.png?id=unique');
    });

    it.each([
        'http://tracker.example/pixel.png',
        'file:///private/var/mobile/secret.png',
        'javascript:alert(1)',
        'data:image/svg+xml,<svg onload="alert(1)"/>',
        ['https://user', ':password@example.com/private.png'].join(''),
        'not a URL',
    ])('blocks unsafe image source %s', (uri) => {
        expect(classifyMarkdownImage(uri)).toEqual({ kind: 'blocked' });
    });

    it.each(['png', 'jpeg', 'gif', 'webp'])('allows a bounded inline %s image without a network request', (format) => {
        const uri = `data:image/${format};base64,YWJjZA==`;
        const policy = classifyMarkdownImage(uri);

        expect(policy).toEqual({ kind: 'inline', uri });
        expect(getMarkdownImageRenderUri(policy, false)).toBe(uri);
    });

    it('blocks malformed and oversized inline images', () => {
        expect(classifyMarkdownImage('data:image/png;base64,not base64!')).toEqual({ kind: 'blocked' });
        expect(classifyMarkdownImage(`data:image/png;base64,${'A'.repeat(3_000_001)}`)).toEqual({ kind: 'blocked' });
        expect(getMarkdownImageRenderUri({ kind: 'blocked' }, true)).toBeNull();
    });
});
