import { describe, expect, it } from 'vitest';
import {
    parseFailedMessageDraft,
    serializeFailedMessageDraft,
    type FailedMessageDraft,
} from './failedMessagePersist';

const validDraft: FailedMessageDraft = {
    text: 'Hello Claude',
    failedAt: 1747584000000,
    source: 'chat',
    displayText: 'Hello Claude',
};

describe('parseFailedMessageDraft', () => {
    it('round-trips a valid draft', () => {
        const raw = serializeFailedMessageDraft(validDraft);
        expect(parseFailedMessageDraft(raw)).toEqual(validDraft);
    });

    it('round-trips a minimal draft (text + failedAt only)', () => {
        const minimal: FailedMessageDraft = { text: 'hi', failedAt: 1 };
        const raw = serializeFailedMessageDraft(minimal);
        expect(parseFailedMessageDraft(raw)).toEqual(minimal);
    });

    it('returns null for invalid JSON', () => {
        expect(parseFailedMessageDraft('not json {{{')).toBeNull();
    });

    it('returns null for empty text (must not surface a Retry on nothing)', () => {
        expect(parseFailedMessageDraft(JSON.stringify({ text: '', failedAt: 1 }))).toBeNull();
    });

    it('returns null for missing text', () => {
        expect(parseFailedMessageDraft(JSON.stringify({ failedAt: 1 }))).toBeNull();
    });

    it('returns null for missing failedAt', () => {
        expect(parseFailedMessageDraft(JSON.stringify({ text: 'hi' }))).toBeNull();
    });

    it('returns null for non-numeric failedAt', () => {
        expect(parseFailedMessageDraft(JSON.stringify({ text: 'hi', failedAt: 'now' }))).toBeNull();
    });

    it('returns null for non-finite failedAt (NaN, Infinity)', () => {
        expect(parseFailedMessageDraft(JSON.stringify({ text: 'hi', failedAt: NaN }))).toBeNull();
    });

    it('drops unknown source values silently (forward compat)', () => {
        const parsed = parseFailedMessageDraft(JSON.stringify({
            text: 'hi',
            failedAt: 1,
            source: 'future-source-not-yet-defined',
        }));
        expect(parsed).toEqual({ text: 'hi', failedAt: 1 });
    });

    it('preserves all known source values', () => {
        for (const source of ['chat', 'new_session', 'option', 'question', 'voice'] as const) {
            const parsed = parseFailedMessageDraft(JSON.stringify({
                text: 'hi',
                failedAt: 1,
                source,
            }));
            expect(parsed?.source).toBe(source);
        }
    });

    it('strips unknown extra fields', () => {
        const parsed = parseFailedMessageDraft(JSON.stringify({
            ...validDraft,
            unknownField: 'whatever',
            nested: { foo: 1 },
        }));
        expect(parsed).toEqual(validDraft);
        expect(parsed).not.toHaveProperty('unknownField');
        expect(parsed).not.toHaveProperty('nested');
    });

    it('returns null for an array', () => {
        expect(parseFailedMessageDraft('[1, 2, 3]')).toBeNull();
    });

    it('returns null for a primitive', () => {
        expect(parseFailedMessageDraft('42')).toBeNull();
        expect(parseFailedMessageDraft('null')).toBeNull();
    });
});

describe('serializeFailedMessageDraft', () => {
    it('produces stable JSON', () => {
        const raw = serializeFailedMessageDraft(validDraft);
        expect(JSON.parse(raw)).toEqual(validDraft);
    });

    it('omits displayText if absent', () => {
        const raw = serializeFailedMessageDraft({ text: 'hi', failedAt: 1 });
        expect(JSON.parse(raw)).toEqual({ text: 'hi', failedAt: 1 });
        expect(raw).not.toContain('displayText');
    });
});
