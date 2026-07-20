import { describe, it, expect } from 'vitest';

/**
 * Thinking block display logic tests.
 *
 * The app identifies thinking blocks via the isThinking flag on AgentTextMessage.
 * MessageView.tsx uses this to:
 *   - Hide thinking messages when showThinking is off
 *   - Render them in a collapsible container when showThinking is on
 *
 * These tests verify the data-level identification logic as pure functions,
 * without importing React Native components.
 */

interface AgentTextMessage {
    kind: 'agent-text';
    id: string;
    localId: string | null;
    createdAt: number;
    text: string;
    isThinking?: boolean;
}

type Message =
    | AgentTextMessage
    | { kind: 'user-text'; id: string; text: string }
    | { kind: 'tool-call'; id: string };

/** Checks whether a message is a thinking block */
function isThinkingBlock(message: Message): boolean {
    return message.kind === 'agent-text' && message.isThinking === true;
}

/** Filters thinking blocks from a message list */
function getThinkingBlocks(messages: Message[]): AgentTextMessage[] {
    return messages.filter(
        (m): m is AgentTextMessage => m.kind === 'agent-text' && m.isThinking === true
    );
}

/** Determines if a message should be visible given the showThinking setting */
function isMessageVisible(message: Message, showThinking: boolean): boolean {
    if (message.kind === 'agent-text' && message.isThinking && !showThinking) {
        return false;
    }
    return true;
}

function makeThinkingMessage(id: string, text: string): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: Date.now(),
        text,
        isThinking: true,
    };
}

function makeAgentMessage(id: string, text: string): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: Date.now(),
        text,
        isThinking: undefined,
    };
}

describe('Thinking block display', () => {

    describe('messages with thinking blocks are identified correctly', () => {
        it('identifies a message with isThinking=true as a thinking block', () => {
            const msg = makeThinkingMessage('t1', 'Let me think about this...');
            expect(isThinkingBlock(msg)).toBe(true);
        });

        it('identifies a regular agent message as not a thinking block', () => {
            const msg = makeAgentMessage('a1', 'Here is the answer.');
            expect(isThinkingBlock(msg)).toBe(false);
        });

        it('does not treat user-text as a thinking block', () => {
            const msg: Message = { kind: 'user-text', id: 'u1', text: 'Hello' };
            expect(isThinkingBlock(msg)).toBe(false);
        });

        it('does not treat tool-call as a thinking block', () => {
            const msg: Message = { kind: 'tool-call', id: 'tc1' };
            expect(isThinkingBlock(msg)).toBe(false);
        });
    });

    describe('messages without thinking blocks handled', () => {
        it('filters to empty when no thinking blocks exist', () => {
            const messages: Message[] = [
                makeAgentMessage('a1', 'Answer'),
                { kind: 'user-text', id: 'u1', text: 'Question' },
            ];
            expect(getThinkingBlocks(messages)).toHaveLength(0);
        });

        it('all non-thinking messages are visible regardless of showThinking setting', () => {
            const msg = makeAgentMessage('a1', 'Normal message');
            expect(isMessageVisible(msg, false)).toBe(true);
            expect(isMessageVisible(msg, true)).toBe(true);
        });
    });

    describe('empty thinking content handled', () => {
        it('identifies empty-text thinking block as a thinking block', () => {
            const msg = makeThinkingMessage('t1', '');
            expect(isThinkingBlock(msg)).toBe(true);
        });

        it('empty thinking block is hidden when showThinking is off', () => {
            const msg = makeThinkingMessage('t1', '');
            expect(isMessageVisible(msg, false)).toBe(false);
        });

        it('empty thinking block is visible when showThinking is on', () => {
            const msg = makeThinkingMessage('t1', '');
            expect(isMessageVisible(msg, true)).toBe(true);
        });
    });

    describe('multiple thinking blocks handled', () => {
        it('extracts all thinking blocks from mixed message list', () => {
            const messages: Message[] = [
                makeThinkingMessage('t1', 'Thinking step 1'),
                makeAgentMessage('a1', 'Intermediate answer'),
                makeThinkingMessage('t2', 'Thinking step 2'),
                { kind: 'user-text', id: 'u1', text: 'Follow up' },
                makeThinkingMessage('t3', 'Thinking step 3'),
            ];
            const thinkingBlocks = getThinkingBlocks(messages);

            expect(thinkingBlocks).toHaveLength(3);
            expect(thinkingBlocks.map(b => b.id)).toEqual(['t1', 't2', 't3']);
        });

        it('hides all thinking blocks when showThinking is off', () => {
            const messages: Message[] = [
                makeThinkingMessage('t1', 'Step 1'),
                makeAgentMessage('a1', 'Response'),
                makeThinkingMessage('t2', 'Step 2'),
            ];
            const visible = messages.filter(m => isMessageVisible(m, false));
            expect(visible).toHaveLength(1);
            expect(visible[0].id).toBe('a1');
        });

        it('shows all messages when showThinking is on', () => {
            const messages: Message[] = [
                makeThinkingMessage('t1', 'Step 1'),
                makeAgentMessage('a1', 'Response'),
                makeThinkingMessage('t2', 'Step 2'),
            ];
            const visible = messages.filter(m => isMessageVisible(m, true));
            expect(visible).toHaveLength(3);
        });
    });
});
