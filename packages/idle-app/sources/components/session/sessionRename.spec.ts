import { describe, it, expect } from 'vitest';

/**
 * Session rename validation tests.
 *
 * The app's rename flow (info.tsx) guards with:
 *   if (newTitle === null || newTitle.trim() === '') return;
 * Then calls sessionRename(id, newTitle.trim()).
 *
 * These tests codify that validation contract as a pure function
 * so it stays correct even if the UI layer changes.
 */

/** Mirrors the validation gate used before calling sessionRename */
function isValidSessionName(name: string | null): boolean {
    if (name === null) return false;
    return name.trim().length > 0;
}

describe('Session rename validation', () => {

    describe('valid names are accepted', () => {
        it('accepts a normal name', () => {
            expect(isValidSessionName('My Session')).toBe(true);
        });

        it('accepts a single character', () => {
            expect(isValidSessionName('A')).toBe(true);
        });

        it('accepts a name with leading/trailing spaces (trimmed content is non-empty)', () => {
            expect(isValidSessionName('  hello  ')).toBe(true);
        });
    });

    describe('empty / whitespace-only names are rejected', () => {
        it('rejects null', () => {
            expect(isValidSessionName(null)).toBe(false);
        });

        it('rejects empty string', () => {
            expect(isValidSessionName('')).toBe(false);
        });

        it('rejects spaces only', () => {
            expect(isValidSessionName('   ')).toBe(false);
        });

        it('rejects tabs and newlines', () => {
            expect(isValidSessionName('\t\n')).toBe(false);
        });
    });

    describe('unicode names work', () => {
        it('accepts CJK characters', () => {
            expect(isValidSessionName('会議ノート')).toBe(true);
        });

        it('accepts emoji', () => {
            expect(isValidSessionName('🚀 Launch')).toBe(true);
        });

        it('accepts Arabic script', () => {
            expect(isValidSessionName('مرحبا')).toBe(true);
        });

        it('accepts mixed scripts', () => {
            expect(isValidSessionName('Hello 世界 🌍')).toBe(true);
        });
    });

    describe('very long names are handled', () => {
        it('accepts a 1000-char name', () => {
            const longName = 'a'.repeat(1000);
            expect(isValidSessionName(longName)).toBe(true);
        });

        it('accepts a 5000-char name', () => {
            const veryLong = 'x'.repeat(5000);
            expect(isValidSessionName(veryLong)).toBe(true);
        });

        it('rejects a 1000-char whitespace-only name', () => {
            const longSpaces = ' '.repeat(1000);
            expect(isValidSessionName(longSpaces)).toBe(false);
        });
    });
});
