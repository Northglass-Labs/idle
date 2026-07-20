import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES } from '@northglass/idle-wire';
import {
    estimateRetainedSessionMessagesBytes,
    MAX_STORED_SESSION_MESSAGES,
    parseBoundedMessagePage,
    retainRecentSessionMessages,
} from './messageHistoryLimits';
import { MAX_RETAINED_SESSION_MESSAGE_BYTES } from './sessionMessageLimits';

const message = (seq: number, content = 'AQID') => ({
    id: `message-${seq}`,
    seq,
    localId: null,
    content: { t: 'encrypted' as const, c: content },
    createdAt: seq,
    updatedAt: seq,
});

describe('message history resource limits', () => {
    it('accepts an ordinary bounded relay page', () => {
        expect(parseBoundedMessagePage({
            messages: [message(1), message(2)],
            hasMore: false,
        })).toEqual({ messages: [message(1), message(2)], hasMore: false });
    });

    it('rejects overfilled, oversized, and malformed relay pages', () => {
        expect(parseBoundedMessagePage({
            messages: Array.from({ length: 26 }, (_, index) => message(index + 1)),
            hasMore: true,
        })).toBeNull();
        const maximumCiphertext = Buffer.alloc(MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_BYTES).toString('base64');
        expect(parseBoundedMessagePage({
            messages: Array.from({ length: 5 }, (_, index) => message(index + 1, maximumCiphertext)),
            hasMore: false,
        })).toBeNull();
        expect(parseBoundedMessagePage({ messages: [message(1)], hasMore: 'yes' })).toBeNull();
        expect(parseBoundedMessagePage({ messages: [message(1)], hasMore: false, attacker: true })).toBeNull();
        expect(parseBoundedMessagePage({ messages: [message(1), message(1)], hasMore: false })).toBeNull();
    });

    it('retains only the newest bounded in-memory message window', () => {
        const all = Object.fromEntries(Array.from({ length: MAX_STORED_SESSION_MESSAGES + 50 }, (_, index) => {
            const item = {
                id: `message-${index}`,
                localId: null,
                createdAt: index,
                isSidechain: false,
                role: 'user' as const,
                content: { type: 'text' as const, text: `message ${index}` },
            };
            return [item.id, item];
        }));

        const retained = retainRecentSessionMessages(all);
        expect(retained.messages).toHaveLength(MAX_STORED_SESSION_MESSAGES);
        expect(retained.messages[0].id).toBe(`message-${MAX_STORED_SESSION_MESSAGES + 49}`);
        expect(retained.messagesMap).not.toHaveProperty('message-0');
    });

    it('counts nested sidechain children inside the same message budget', () => {
        const children = Array.from({ length: MAX_STORED_SESSION_MESSAGES + 50 }, (_, index) => ({
            id: `child-${index}`,
            localId: null,
            createdAt: index,
            kind: 'agent-text' as const,
            text: `child ${index}`,
        }));
        const root = {
            id: 'root-tool',
            localId: null,
            createdAt: MAX_STORED_SESSION_MESSAGES + 100,
            kind: 'tool-call' as const,
            tool: {},
            children,
        };

        const retained = retainRecentSessionMessages({ [root.id]: root });
        const retainedChildren = retained.messages[0].children;

        expect(retained.messages).toHaveLength(1);
        expect(retainedChildren).toHaveLength(MAX_STORED_SESSION_MESSAGES - 1);
        expect(retainedChildren.some((child) => child.id === 'child-0')).toBe(false);
        expect(retainedChildren.some((child) => child.id === `child-${children.length - 1}`)).toBe(true);
    });

    it('keeps one maximum-size message usable but prevents large plaintext accumulation', () => {
        const maximumTransportPlaintext = 'A'.repeat(4 * 1024 * 1024);
        const messages = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
            const item = {
                id: `large-message-${index}`,
                localId: null,
                createdAt: index,
                kind: 'agent-text' as const,
                text: maximumTransportPlaintext,
            };
            return [item.id, item];
        }));

        const retained = retainRecentSessionMessages(messages);

        expect(retained.messages.length).toBeGreaterThanOrEqual(1);
        expect(retained.messages.length).toBeLessThan(10);
        expect(retained.messages[0].text).toHaveLength(4 * 1024 * 1024);
        expect(estimateRetainedSessionMessagesBytes(retained.messages))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);
    });

    it('charges nested sidechain payloads against the same 32 MiB budget', () => {
        const maximumTransportPlaintext = 'B'.repeat(4 * 1024 * 1024);
        const children = Array.from({ length: 10 }, (_, index) => ({
            id: `large-child-${index}`,
            localId: null,
            createdAt: index,
            kind: 'agent-text' as const,
            text: maximumTransportPlaintext,
        }));
        const root = {
            id: 'large-root-tool',
            localId: null,
            createdAt: 100,
            kind: 'tool-call' as const,
            tool: { input: { prompt: 'bounded sidechain' } },
            children,
        };

        const retained = retainRecentSessionMessages({ [root.id]: root });

        expect(retained.messages).toHaveLength(1);
        expect(retained.messages[0].children.length).toBeGreaterThanOrEqual(1);
        expect(retained.messages[0].children.length).toBeLessThan(children.length);
        expect(estimateRetainedSessionMessagesBytes(retained.messages))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);
    });

    it('does not automatically prefetch every older history page', () => {
        const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
        expect(source).not.toContain('prefetchOlderMessagesInBackground');
    });
});
