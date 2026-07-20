import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildAuthenticatedRequestUrl } from './authenticatedRequestUrl';

describe('authenticated request URL boundary', () => {
    it('builds a same-origin API URL with an ordinary encoded query', () => {
        expect(buildAuthenticatedRequestUrl(
            'https://relay.example',
            '/v3/sessions/session-1/messages?after_seq=2&limit=25',
        )).toBe('https://relay.example/v3/sessions/session-1/messages?after_seq=2&limit=25');
    });

    it.each([
        { label: 'authority override', path: '//attacker.example/v1/profile' },
        { label: 'dot traversal', path: '/v1/sessions/../account/profile' },
        { label: 'encoded traversal', path: '/v1/sessions/%2e%2e/account/profile' },
        { label: 'backslash traversal', path: '/v1/sessions\\..\\account/profile' },
        { label: 'fragment', path: '/v1/profile#hidden-fragment' },
        { label: 'non-API route', path: '/not-an-api/path' },
        { label: 'oversized path', path: `/${'x'.repeat(4_096)}` },
    ])('rejects an unsafe authenticated request path: $label', ({ path }) => {
        expect(() => buildAuthenticatedRequestUrl('https://relay.example', path)).toThrow(
            'Invalid authenticated request path',
        );
    });

    it('is the only URL construction path used by the authenticated client', () => {
        const source = readFileSync(new URL('./apiSocket.ts', import.meta.url), 'utf8');

        expect(source).toContain('buildAuthenticatedRequestUrl(this.config.endpoint, path)');
        expect(source).not.toContain('`${this.config.endpoint}${path}`');
    });

    it('percent-encodes record identifiers before placing them in request paths', () => {
        const syncSource = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        const operationsSource = readFileSync(new URL('./ops.ts', import.meta.url), 'utf8');
        const attachmentSource = readFileSync(new URL('./apiAttachments.ts', import.meta.url), 'utf8');

        expect(syncSource).toContain('const encodedSessionId = encodeURIComponent(sessionId);');
        expect(syncSource).not.toMatch(/apiSocket\.request\(`\/v3\/sessions\/\$\{sessionId\}/);
        expect(operationsSource).toContain('encodeURIComponent(machineId)');
        expect(operationsSource).toContain('encodeURIComponent(sessionId)');
        expect(operationsSource).not.toMatch(/apiSocket\.request\(`\/v1\/(?:machines|sessions)\/\$\{(?:machineId|sessionId)\}/);
        expect(attachmentSource).toContain('const encodedSessionId = encodeURIComponent(sessionId);');
        expect(attachmentSource).not.toMatch(/\/sessions\/\$\{sessionId\}\/attachments/);
    });
});
