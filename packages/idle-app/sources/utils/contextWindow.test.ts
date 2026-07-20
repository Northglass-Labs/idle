import { describe, expect, it } from 'vitest';
import {
    CLAUDE_3_ERA_CONTEXT_WINDOW,
    DEFAULT_CONTEXT_WINDOW,
    EXTENDED_CONTEXT_WINDOW,
    getEnsoContextSize,
    getMaxContextSize,
} from './contextWindow';

describe('getMaxContextSize', () => {
    it.each([
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
    ])('returns 1M for %s', (model) => {
        expect(getMaxContextSize(model)).toBe(EXTENDED_CONTEXT_WINDOW);
    });

    it('matches normalized and dated current model IDs', () => {
        expect(getMaxContextSize('  CLAUDE-OPUS-4-8-20260713  ')).toBe(EXTENDED_CONTEXT_WINDOW);
        expect(getMaxContextSize('claude-sonnet-5-20260713')).toBe(EXTENDED_CONTEXT_WINDOW);
    });

    it.each([
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-3-5-sonnet-20241022',
    ])('returns 200k for %s', (model) => {
        expect(getMaxContextSize(model)).toBe(CLAUDE_3_ERA_CONTEXT_WINDOW);
    });

    it.each([undefined, null, '', 'unknown', 'claude-opus-4-80'])(
        'uses the safe 200k default for an unavailable or unknown model (%s)',
        (model) => {
            expect(getMaxContextSize(model)).toBe(DEFAULT_CONTEXT_WINDOW);
        },
    );
});

describe('getEnsoContextSize', () => {
    it('uses the exact model when metadata provides it', () => {
        expect(getEnsoContextSize({
            flavor: 'claude',
            currentModelCode: 'claude-opus-4-8',
        })).toBe(EXTENDED_CONTEXT_WINDOW);
        expect(getEnsoContextSize({
            flavor: 'claude',
            currentModelCode: 'claude-haiku-4-5',
        })).toBe(CLAUDE_3_ERA_CONTEXT_WINDOW);
    });

    it.each([
        { flavor: 'claude' },
        { flavor: 'claude', currentModelCode: null },
        { flavor: 'gemini' },
        {},
        null,
        undefined,
    ])('does not invent a 1M window when the exact model is missing', (metadata) => {
        expect(getEnsoContextSize(metadata)).toBe(DEFAULT_CONTEXT_WINDOW);
    });
});
