import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({
    sessions: {} as Record<string, Session>,
    messages: {} as Record<string, { messages: Message[] }>,
    sendContextualUpdate: vi.fn(),
    sendTextMessage: vi.fn(),
}));

vi.mock('@/sync/storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => value,
    getOperationalAgentState: (value: unknown) => value,
    storage: {
        getState: () => ({
            sessions: mocks.sessions,
            sessionMessages: mocks.messages,
            realtimeMode: 'idle',
            getActiveSessions: () => Object.values(mocks.sessions).filter((session) => session.active),
        }),
        subscribe: vi.fn(() => vi.fn()),
    },
}));

vi.mock('../RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => null,
    getVoiceSession: () => ({
        sendContextualUpdate: mocks.sendContextualUpdate,
        sendTextMessage: mocks.sendTextMessage,
    }),
    isVoiceSessionStarted: () => true,
    setCurrentRealtimeSessionId: vi.fn(),
}));

vi.mock('../voiceConfig', () => ({
    VOICE_CONFIG: {
        DISABLE_TOOL_CALLS: true,
        DISABLE_SESSION_STATUS: false,
        DISABLE_SESSION_FOCUS: false,
        DISABLE_PERMISSION_REQUESTS: false,
        DISABLE_MESSAGES: false,
        DISABLE_READY_EVENTS: false,
        MAX_HISTORY_MESSAGES: 50,
    },
}));

import { voiceHooks } from './voiceHooks';

function makeSession(id: string, summary: string, active = true): Session {
    return {
        id,
        active,
        createdAt: 1,
        metadata: {
            path: `/Users/private-person/Projects/${id}`,
            host: 'personal-mac-name',
            summary: { text: summary, updatedAt: 1 },
        },
        agentState: { requests: {} },
    } as Session;
}

describe('voice initial provider payload boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.sessions = {};
        mocks.messages = {};
        voiceHooks.onVoiceStopped();
    });

    it('prioritizes and bounds the current session without exposing local paths', () => {
        for (let index = 0; index < 200; index += 1) {
            const id = `background-${index}`;
            mocks.sessions[id] = makeSession(id, `background title ${index} ` + 'x'.repeat(2_000));
        }
        mocks.sessions.current = makeSession('current', 'current-session-title');
        mocks.messages.current = {
            messages: [{
                kind: 'agent-text',
                id: 'current-message',
                localId: null,
                createdAt: 1,
                text: 'current transcript update',
            }],
        };

        const prompt = voiceHooks.onVoiceStarted('current');

        expect(prompt.length).toBeLessThanOrEqual(32 * 1024);
        expect(prompt).toContain('current-session-title');
        expect(prompt).toContain('current transcript update');
        expect(prompt).not.toContain('/Users/private-person');
        expect(prompt).not.toContain('personal-mac-name');
    });

    it('keeps the current session summary when that session is not in the active directory', () => {
        mocks.sessions.background = makeSession('background', 'background-session-title');
        mocks.sessions.current = makeSession('current', 'inactive-current-session-title', false);
        mocks.messages.current = { messages: [] };

        const prompt = voiceHooks.onVoiceStarted('current');

        expect(prompt).toContain('background-session-title');
        expect(prompt).toContain('inactive-current-session-title');
    });
});
