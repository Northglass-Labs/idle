import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const metadata = {
        path: '/relay-selected/private-path',
        host: 'relay-host',
        summary: { text: 'relay-selected summary' },
        machineId: 'relay-machine',
    };
    const agentState = {
        requests: {
            replayed: {
                tool: 'Bash',
                arguments: { command: 'open door' },
                createdAt: 1,
            },
        },
    };
    const session = {
        id: 'legacy-session',
        active: true,
        metadata,
        agentState,
    };
    return {
        metadata,
        agentState,
        session,
        metadataTrusted: false,
        agentStateTrusted: false,
        sendContextualUpdate: vi.fn(),
        sendTextMessage: vi.fn(),
    };
});

vi.mock('@/sync/storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => (
        mocks.metadataTrusted ? value : null
    ),
    getOperationalAgentState: (value: unknown) => (
        mocks.agentStateTrusted ? value : null
    ),
    storage: {
        getState: () => ({
            sessions: { 'legacy-session': mocks.session },
            sessionMessages: { 'legacy-session': { messages: [] } },
            realtimeMode: 'idle',
            getActiveSessions: () => [mocks.session],
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
        DISABLE_SESSION_STATUS: false,
        DISABLE_SESSION_FOCUS: false,
        DISABLE_PERMISSION_REQUESTS: false,
        DISABLE_MESSAGES: false,
        DISABLE_READY_EVENTS: false,
    },
}));

import { voiceHooks } from './voiceHooks';

describe('voice legacy trust boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.metadataTrusted = false;
        mocks.agentStateTrusted = false;
        voiceHooks.onVoiceStopped();
    });

    it('omits display-only legacy sessions from the voice directory and initial context', () => {
        const prompt = voiceHooks.onVoiceStarted('legacy-session');

        expect(prompt).toBe('No active sessions.\n\n');
        expect(prompt).not.toContain('/relay-selected/private-path');
        expect(prompt).not.toContain('relay-selected summary');
        expect(prompt).not.toContain('open door');
    });

    it('does not inject display-only legacy context on focus', () => {
        voiceHooks.onSessionFocus('legacy-session', mocks.metadata);

        expect(mocks.sendContextualUpdate).not.toHaveBeenCalled();
        expect(mocks.sendTextMessage).not.toHaveBeenCalled();
    });
});
