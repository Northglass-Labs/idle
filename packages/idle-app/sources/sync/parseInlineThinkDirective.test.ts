import { describe, it, expect } from 'vitest';
import { parseInlineThinkDirective } from './parseInlineThinkDirective';

describe('parseInlineThinkDirective', () => {
    it('returns null for empty input', () => {
        expect(parseInlineThinkDirective('')).toBe(null);
    });

    it('returns null for text without the /think prefix', () => {
        expect(parseInlineThinkDirective('hello world')).toBe(null);
    });

    it('returns null for bare /think (no tier)', () => {
        // Left in text so Claude can interpret natively
        expect(parseInlineThinkDirective('/think')).toBe(null);
    });

    it('returns null for /think with unknown tier', () => {
        expect(parseInlineThinkDirective('/think bogus hello')).toBe(null);
    });

    it('parses /think low + remaining text', () => {
        expect(parseInlineThinkDirective('/think low what is 2+2')).toEqual({
            tier: 'low',
            remainingText: 'what is 2+2',
        });
    });

    it('parses /think medium', () => {
        expect(parseInlineThinkDirective('/think medium hello')).toEqual({
            tier: 'medium',
            remainingText: 'hello',
        });
    });

    it('parses /think high', () => {
        expect(parseInlineThinkDirective('/think high deep question')).toEqual({
            tier: 'high',
            remainingText: 'deep question',
        });
    });

    it('parses /think xhigh', () => {
        expect(parseInlineThinkDirective('/think xhigh complex task')).toEqual({
            tier: 'xhigh',
            remainingText: 'complex task',
        });
    });

    it('parses /think max', () => {
        expect(parseInlineThinkDirective('/think max solve this')).toEqual({
            tier: 'max',
            remainingText: 'solve this',
        });
    });

    it('handles tier with no following body (empty remainingText)', () => {
        expect(parseInlineThinkDirective('/think max')).toEqual({
            tier: 'max',
            remainingText: '',
        });
    });

    it('preserves multi-line body after the directive', () => {
        const input = '/think high here is\nmy question\nwith newlines';
        expect(parseInlineThinkDirective(input)).toEqual({
            tier: 'high',
            remainingText: 'here is\nmy question\nwith newlines',
        });
    });

    it('preserves leading whitespace within the body (only the single separator is consumed)', () => {
        expect(parseInlineThinkDirective('/think low   spaced')).toEqual({
            tier: 'low',
            remainingText: '  spaced',
        });
    });

    it('is case-sensitive on the tier (rejects MIXED case)', () => {
        // We deliberately accept only lowercase to match the cogwheel labels
        expect(parseInlineThinkDirective('/think Max hello')).toBe(null);
    });

    it('does not match /think substrings deeper in the text', () => {
        expect(parseInlineThinkDirective('please /think max about this')).toBe(null);
    });

    // /ultrathink is Claude Code's first-class shortcut for max-effort
    // reasoning. Treat it as syntactic sugar for `/think max`.

    it('parses /ultrathink + remaining text as max tier', () => {
        expect(parseInlineThinkDirective('/ultrathink solve this hard problem')).toEqual({
            tier: 'max',
            remainingText: 'solve this hard problem',
        });
    });

    it('parses bare /ultrathink (no body) as max tier with empty remainingText', () => {
        expect(parseInlineThinkDirective('/ultrathink')).toEqual({
            tier: 'max',
            remainingText: '',
        });
    });

    it('does not match /ultrathink substrings deeper in the text', () => {
        expect(parseInlineThinkDirective('please /ultrathink about this')).toBe(null);
    });

    it('is case-sensitive on /ultrathink (rejects MIXED case)', () => {
        expect(parseInlineThinkDirective('/UltraThink hello')).toBe(null);
    });
});
