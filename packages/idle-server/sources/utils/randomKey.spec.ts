import { describe, it, expect } from 'vitest';
import { randomKey } from './randomKey';

describe('randomKey', () => {
    it('returns a string with the prefix separated by an underscore', () => {
        const key = randomKey('sk');
        expect(key.startsWith('sk_')).toBe(true);
    });

    it('returns default total length: prefix + "_" + 24 chars', () => {
        const key = randomKey('sk');
        // "sk_" is 3 chars, body is 24 chars
        expect(key).toHaveLength('sk'.length + 1 + 24);
    });

    it('respects a custom length for the random body', () => {
        const key = randomKey('tok', 32);
        expect(key).toHaveLength('tok'.length + 1 + 32);
    });

    it('random body contains only alphanumeric characters', () => {
        for (let i = 0; i < 20; i++) {
            const key = randomKey('pfx');
            const body = key.slice('pfx_'.length);
            expect(body).toMatch(/^[a-zA-Z0-9]+$/);
        }
    });

    it('generates unique keys across multiple calls', () => {
        const keys = new Set(Array.from({ length: 50 }, () => randomKey('sk')));
        expect(keys.size).toBe(50);
    });

    it('works with longer prefixes', () => {
        const key = randomKey('session_token');
        expect(key.startsWith('session_token_')).toBe(true);
        const body = key.slice('session_token_'.length);
        expect(body).toHaveLength(24);
    });

    it('works with length 1 (minimum plausible body)', () => {
        const key = randomKey('p', 1);
        expect(key).toHaveLength(3); // "p_" + 1 char
        expect(key).toMatch(/^p_[a-zA-Z0-9]$/);
    });
});
