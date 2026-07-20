/** Pure parser and serializer for the in-memory failed-message retry state. */

import type { MessageSentSource } from '@/track';

export interface FailedMessageDraft {
    text: string;
    failedAt: number;
    source?: MessageSentSource;
    displayText?: string;
}

const KNOWN_SOURCES: readonly MessageSentSource[] = ['chat', 'new_session', 'option', 'question', 'voice'];

function isKnownSource(value: unknown): value is MessageSentSource {
    return typeof value === 'string' && (KNOWN_SOURCES as readonly string[]).includes(value);
}

export function parseFailedMessageDraft(raw: string): FailedMessageDraft | null {
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const u = obj as Record<string, unknown>;
    if (typeof u.text !== 'string' || u.text.length === 0) return null;
    if (typeof u.failedAt !== 'number' || !Number.isFinite(u.failedAt)) return null;

    const draft: FailedMessageDraft = { text: u.text, failedAt: u.failedAt };
    if (isKnownSource(u.source)) {
        draft.source = u.source;
    }
    if (typeof u.displayText === 'string') {
        draft.displayText = u.displayText;
    }
    return draft;
}

export function serializeFailedMessageDraft(draft: FailedMessageDraft): string {
    return JSON.stringify(draft);
}
