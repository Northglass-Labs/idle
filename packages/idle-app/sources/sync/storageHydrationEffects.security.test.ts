import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    voiceText: vi.fn(),
}));

vi.mock('./persistence', () => ({
    loadSettings: () => ({ settings: {}, version: 0 }),
    loadLocalSettings: () => ({}),
    loadPurchases: () => ({ activeSubscriptions: [], entitlements: {} }),
    loadProfile: () => ({
        id: 'account-a',
        timestamp: 0,
        firstName: null,
        lastName: null,
        avatar: null,
        github: null,
    }),
    loadSessionDrafts: () => ({}),
    loadSessionPermissionModes: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionEffortLevels: () => ({}),
    loadSessionLatestUsage: () => null,
    loadSessionFailedMessage: () => null,
    saveLocalSettings: vi.fn(),
    saveSettings: vi.fn(),
    savePurchases: vi.fn(),
    saveProfile: vi.fn(),
    saveSessionDrafts: vi.fn(),
    saveSessionPermissionModes: vi.fn(),
    saveSessionModelModes: vi.fn(),
    saveSessionEffortLevels: vi.fn(),
    saveSessionLatestUsage: vi.fn(),
    saveSessionFailedMessage: vi.fn(),
    clearSessionFailedMessage: vi.fn(),
}));
vi.mock('./sync', () => ({ sync: { applySettings: vi.fn() } }));
vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => 'session-permission',
    getVoiceSession: () => ({ sendTextMessage: mocks.voiceText }),
}));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { buildSessionRowData, storage } from './storage';
import { createReducer } from './reducer/reducer';

function session(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        seq: 1,
        createdAt: 100,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        metadata: { path: '/workspace', host: 'host' },
        metadataVersion: 1,
        agentState: {},
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
        ...overrides,
    };
}

function loadedMessages() {
    return {
        messages: [],
        messagesMap: {},
        reducerState: createReducer(),
        isLoaded: true,
        hasMoreOlder: false,
        isLoadingOlder: false,
    };
}

describe('storage hydration effect boundary', () => {
    beforeEach(() => {
        mocks.voiceText.mockClear();
        (storage as any).setState({
            sessions: {},
            sessionsData: null,
            sessionListViewData: null,
            sessionMessages: {},
            failedMessageDrafts: {},
            unreadSessionIds: new Set<string>(),
            currentViewingSessionId: null,
        });
    });

    it('stores legacy hydration for display without reducer, permission, voice, or unread effects', () => {
        const permissionOld = session('session-permission');
        const unreadOld = session('session-unread', {
            thinking: true,
            agentState: {
                requests: {
                    waiting: {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1,
                    },
                },
            },
        });
        (storage as any).setState({
            sessions: {
                'session-permission': permissionOld,
                'session-unread': unreadOld,
            },
            sessionMessages: {
                'session-permission': loadedMessages(),
                'session-unread': loadedMessages(),
            },
            unreadSessionIds: new Set<string>(),
        });

        const legacyPermissionState = {
            requests: {
                replayed: {
                    tool: 'Write',
                    arguments: { file_path: '/workspace/replayed.txt' },
                    createdAt: 2,
                },
            },
        };
        (storage.getState().applySessions as any)([
            session('session-permission', {
                updatedAt: 200,
                agentState: legacyPermissionState,
                agentStateVersion: 2,
            }),
            session('session-unread', {
                updatedAt: 200,
                thinking: false,
                agentState: {},
                agentStateVersion: 2,
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set<string>(),
        });

        expect(storage.getState().sessions['session-permission']?.agentState)
            .toEqual(legacyPermissionState);
        expect(buildSessionRowData(storage.getState().sessions['session-permission']!))
            .toMatchObject({ state: 'waiting' });
        expect(storage.getState().sessionMessages['session-permission']?.messages).toEqual([]);
        expect(storage.getState().sessionMessages['session-unread']?.messages).toEqual([]);
        expect(storage.getState().unreadSessionIds).toEqual(new Set());
        expect(mocks.voiceText).not.toHaveBeenCalled();
    });

    it('keeps legacy agent state out of reducers when messages arrive or finish loading later', () => {
        const legacyState = {
            requests: {
                replayed: {
                    tool: 'Write',
                    arguments: { file_path: '/workspace/replayed.txt' },
                    createdAt: 2,
                },
            },
        };
        (storage.getState().applySessions as any)([
            session('legacy-message-page', {
                agentState: legacyState,
                agentStateVersion: 0,
            }),
            session('legacy-load-complete', {
                agentState: legacyState,
                agentStateVersion: 0,
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set<string>(),
        });

        storage.getState().applyMessages('legacy-message-page', []);
        storage.getState().applyMessagesLoaded('legacy-load-complete');

        expect(storage.getState().sessions['legacy-message-page']?.agentState).toEqual(legacyState);
        expect(storage.getState().sessions['legacy-load-complete']?.agentState).toEqual(legacyState);
        expect(storage.getState().sessionMessages['legacy-message-page']?.messages).toEqual([]);
        expect(storage.getState().sessionMessages['legacy-load-complete']?.messages).toEqual([]);
        expect(mocks.voiceText).not.toHaveBeenCalled();
    });

    it('keeps reducer processing for explicitly authenticated hydration without a second voice sink', () => {
        (storage as any).setState({
            sessions: { 'session-permission': session('session-permission') },
            sessionMessages: { 'session-permission': loadedMessages() },
            unreadSessionIds: new Set<string>(),
        });

        (storage.getState().applySessions as any)([
            session('session-permission', {
                updatedAt: 200,
                agentStateVersion: 2,
                agentState: {
                    requests: {
                        bound: {
                            tool: 'Write',
                            arguments: { file_path: '/workspace/bound.txt' },
                            createdAt: 2,
                        },
                    },
                },
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set(['session-permission']),
        });

        expect(storage.getState().sessionMessages['session-permission']?.messages.length).toBeGreaterThan(0);
        expect(buildSessionRowData(storage.getState().sessions['session-permission']!))
            .toMatchObject({ state: 'permission_required' });
        expect(mocks.voiceText).not.toHaveBeenCalled();
    });

    it('retains authenticated provenance across delayed message loading', () => {
        const boundState = {
            requests: {
                bound: {
                    tool: 'Write',
                    arguments: { file_path: '/workspace/bound.txt' },
                    createdAt: 2,
                },
            },
        };
        (storage.getState().applySessions as any)([
            session('bound-load-complete', {
                agentState: boundState,
                agentStateVersion: 2,
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set(['bound-load-complete']),
        });

        storage.getState().applyMessagesLoaded('bound-load-complete');

        expect(storage.getState().sessionMessages['bound-load-complete']?.messages.length)
            .toBeGreaterThan(0);
        expect(mocks.voiceText).not.toHaveBeenCalled();
    });

    it('exposes project path keys only for authenticated operational metadata', () => {
        (storage.getState().applySessions as any)([
            session('legacy-path', {
                metadata: {
                    path: '/relay-selected/project',
                    host: 'host',
                    machineId: 'relay-machine',
                },
                metadataVersion: 0,
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set<string>(),
            effectfulMetadataSessionIds: new Set<string>(),
        });
        expect(storage.getState().getSessionPathKey('legacy-path')).toBeNull();

        (storage.getState().applySessions as any)([
            session('bound-path', {
                metadata: {
                    path: '/trusted/project',
                    host: 'host',
                    machineId: 'trusted-machine',
                },
                metadataVersion: 1,
            }),
        ], {
            source: 'hydration',
            effectfulAgentStateSessionIds: new Set<string>(),
            effectfulMetadataSessionIds: new Set(['bound-path']),
        });
        expect(storage.getState().getSessionPathKey('bound-path'))
            .toBe('trusted-machine:/trusted/project');
    });
});
