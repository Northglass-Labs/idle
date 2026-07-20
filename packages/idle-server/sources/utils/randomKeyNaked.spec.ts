import { describe, it, expect } from 'vitest';
import { randomKeyNaked } from './randomKeyNaked';

describe('randomKeyNaked', () => {
    it('returns a string of the default length (24)', () => {
        const key = randomKeyNaked();
        expect(key).toHaveLength(24);
    });

    it('returns a string of the specified length', () => {
        expect(randomKeyNaked(32)).toHaveLength(32);
        expect(randomKeyNaked(8)).toHaveLength(8);
    });

    it('contains no underscore separator — it is prefix-free', () => {
        for (let i = 0; i < 20; i++) {
            expect(randomKeyNaked()).not.toContain('_');
        }
    });

    it('contains only alphanumeric characters', () => {
        for (let i = 0; i < 20; i++) {
            expect(randomKeyNaked()).toMatch(/^[a-zA-Z0-9]+$/);
        }
    });

    it('generates unique keys across multiple calls', () => {
        const keys = new Set(Array.from({ length: 50 }, () => randomKeyNaked()));
        expect(keys.size).toBe(50);
    });

    it('works with length 1 (minimum plausible body)', () => {
        const key = randomKeyNaked(1);
        expect(key).toHaveLength(1);
        expect(key).toMatch(/^[a-zA-Z0-9]$/);
    });

    it('works with a large length (e.g. 128)', () => {
        const key = randomKeyNaked(128);
        expect(key).toHaveLength(128);
        expect(key).toMatch(/^[a-zA-Z0-9]+$/);
    });
});
