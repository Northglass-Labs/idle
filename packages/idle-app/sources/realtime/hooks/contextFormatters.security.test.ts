import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import {
    formatHistory,
    formatMessage,
    formatNewMessages,
    formatPermissionRequest,
    formatSessionFull,
} from './contextFormatters';

const MAX_PROVIDER_CONTEXT_CHARS = 32 * 1024;

function textMessage(createdAt: number, text: string): Message {
    return {
        kind: 'agent-text',
        id: `message-${createdAt}`,
        localId: null,
        createdAt,
        text,
    };
}

function session(summary: string): Session {
    return {
        id: 'session-opaque-id',
        metadata: {
            path: '/Users/private-person/Projects/confidential-client',
            host: 'personal-mac-name',
            homeDir: '/Users/private-person',
            summary: { text: summary, updatedAt: 1 },
        },
    } as Session;
}

describe('voice provider context privacy boundary', () => {
    it('omits project and home paths and emits a session summary only once', () => {
        const formatted = formatSessionFull(session('Review the authentication flow'), []);

        expect(formatted).not.toContain('/Users/private-person');
        expect(formatted).not.toContain('confidential-client');
        expect(formatted).not.toContain('personal-mac-name');
        expect(formatted.match(/Review the authentication flow/g)).toHaveLength(1);
    });

    it('selects the newest history window and presents it chronologically', () => {
        const messages = Array.from({ length: 60 }, (_, index) => {
            const createdAt = 60 - index;
            return textMessage(createdAt, createdAt <= 10 ? `old-${createdAt}` : `recent-${createdAt}`);
        });

        const history = formatHistory('session-opaque-id', messages);

        expect(history).not.toMatch(/old-(?:[1-9]|10)\b/);
        expect(history).toContain('recent-11');
        expect(history).toContain('recent-60');
        expect(history.indexOf('recent-11')).toBeLessThan(history.indexOf('recent-60'));
    });

    it('never serializes permission arguments into the voice-provider prompt', () => {
        const formatted = formatPermissionRequest(
            'session-opaque-id',
            'request-opaque-id',
            'Bash',
            { command: 'deploy --token provider-secret-value' },
        );

        expect(formatted).toContain('session-opaque-id');
        expect(formatted).toContain('request-opaque-id');
        expect(formatted).toContain('Bash');
        expect(formatted).not.toContain('provider-secret-value');
        expect(formatted).not.toContain('tool_args');
    });

    it('keeps general tool calls local instead of forwarding arguments, descriptions, or names', () => {
        const formatted = formatMessage({
            kind: 'tool-call',
            id: 'tool-call-id',
            localId: null,
            createdAt: 1,
            children: [],
            tool: {
                name: 'Bash',
                description: 'run with provider-secret-value',
                input: { command: 'deploy --token provider-secret-value' },
                state: 'running',
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
            },
        });

        expect(formatted).toBeNull();
    });

    it('bounds initial session context and incremental transcript updates', () => {
        const hugeSummary = 'summary-'.repeat(20_000);
        const hugeMessages = Array.from({ length: 100 }, (_, index) => (
            textMessage(index, `message-${index}-` + 'x'.repeat(16 * 1024))
        ));

        expect(formatSessionFull(session(hugeSummary), hugeMessages).length)
            .toBeLessThanOrEqual(MAX_PROVIDER_CONTEXT_CHARS);
        expect(formatNewMessages('session-opaque-id', hugeMessages).length)
            .toBeLessThanOrEqual(MAX_PROVIDER_CONTEXT_CHARS);
    });
});
