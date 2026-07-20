import { create } from "zustand";
import { useShallow } from 'zustand/react/shallow'
import equal from 'fast-deep-equal'

function useDeepEqual<T>(selector: (state: StorageState) => T): (state: StorageState) => T {
    const prev = React.useRef<T>(undefined);
    return (state: StorageState) => {
        const next = selector(state);
        return equal(prev.current, next) ? prev.current! : (prev.current = next);
    };
}
import { Session, Machine, GitStatus, type AgentState, type Metadata } from "./storageTypes";
import type { GitStatusFiles } from "./gitStatusFiles";
import { limitAllSessionFileCaches } from './fileLoadPolicy';
import type { ProjectFilesList } from "./projectFiles";
import { createReducer, pruneReducerState, reducer, ReducerState } from "./reducer/reducer";
import { Message } from "./typesMessage";
import { NormalizedMessage } from "./typesRaw";
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName, getSessionSubtitle, getSessionAvatarId, type SessionState } from '@/utils/sessionUtils';
import { applySettings, Settings } from "./settings";
import { LocalSettings, applyLocalSettings } from "./localSettings";
import { Purchases, customerInfoToPurchases } from "./purchases";
import { Profile } from "./profile";
import { loadSettings, loadLocalSettings, saveLocalSettings, saveSettings, loadPurchases, savePurchases, loadProfile, saveProfile, loadSessionDrafts, saveSessionDrafts, loadSessionPermissionModes, saveSessionPermissionModes, loadSessionModelModes, saveSessionModelModes, loadSessionEffortLevels, saveSessionEffortLevels, loadSessionLatestUsage, saveSessionLatestUsage, loadSessionFailedMessage, saveSessionFailedMessage, clearSessionFailedMessage } from "./persistence";
import type { FailedMessageDraft } from "./failedMessagePersist";
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import type { CustomerInfo } from './revenueCat/types';
import React from "react";
import { sync } from "./sync";
import { isMutableTool } from "@/components/tools/knownTools";
import { DecryptedArtifact } from "./artifactTypes";
import { filterRetainedSessionMessages, retainRecentSessionMessages } from "./messageHistoryLimits";
import { retainAgentStateWithinBudget } from './agentStateRetention';
import {
    getOperationalSessionMetadata,
    getOperationalSessionIndicators,
    isAgentStateAuthenticatedForEffects,
    isMetadataAuthenticatedForEffects,
    markAgentStateAuthenticatedForEffects,
    markMetadataAuthenticatedForEffects,
} from './sessionOperationalState';
export {
    getOperationalAgentState,
    getOperationalSessionMetadata,
    isAgentStateAuthenticatedForEffects,
    isMetadataAuthenticatedForEffects,
} from './sessionOperationalState';

// Debounce timer for realtimeMode changes
let realtimeModeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const REALTIME_MODE_DEBOUNCE_MS = 150;

/**
 * Centralized session online state resolver
 * Returns either "online" (string) or a timestamp (number) for last seen
 */
function resolveSessionOnlineState(session: { active: boolean; activeAt: number }): "online" | number {
    // Session is online if the active flag is true
    return session.active ? "online" : session.activeAt;
}

/**
 * Checks if a session should be shown in the active sessions group
 */
function isSessionActive(session: { active: boolean; activeAt: number }): boolean {
    // Use the active flag directly, no timeout checks
    return session.active;
}

// Known entitlement IDs
export type KnownEntitlements = 'pro';

interface SessionMessages {
    messages: Message[];
    messagesMap: Record<string, Message>;
    reducerState: ReducerState;
    isLoaded: boolean;
    // True when the server reported more older messages exist beyond the
    // oldest one we currently have. Drives the "load older" affordance in
    // the chat list. Defaults to false until the initial fetch resolves —
    // the UI must not show a stale paginate-up spinner before that.
    hasMoreOlder: boolean;
    // True while a backward (older-history) page is in flight. Used by the
    // chat list to render a loading footer at the top of the inverted list
    // and to suppress duplicate triggers from FlatList onEndReached.
    isLoadingOlder: boolean;
}

// Machine type is now imported from storageTypes - represents persisted machine data

// Display-only row data — all primitives, cheap to deep-equal
export interface SessionRowData {
    id: string;
    name: string;
    subtitle: string;
    avatarId: string;
    flavor: string | null;
    state: SessionState;
    // Only present on inactive sessions — active sessions never show "last seen"
    // and activeAt updates on every heartbeat, causing needless deep-equal diffs
    activeAt?: number;
    createdAt?: number;
    hasDraft: boolean;
    active: boolean;
    machineId: string | null;
    path: string | null;
    homeDir: string | null;
    completedTodosCount: number;
    totalTodosCount: number;
    hasUnread: boolean;
}

export function buildSessionRowData(session: Session, unreadSessionIds?: Set<string>): SessionRowData {
    const isOnline = session.presence === "online";
    const { hasPendingPermissions: hasPermissions } = getOperationalSessionIndicators(session);

    let state: SessionState;
    if (!isOnline) {
        state = 'disconnected';
    } else if (hasPermissions) {
        state = 'permission_required';
    } else if (session.thinking) {
        state = 'thinking';
    } else {
        state = 'waiting';
    }

    return {
        id: session.id,
        name: getSessionName(session),
        subtitle: getSessionSubtitle(session),
        avatarId: getSessionAvatarId(session),
        flavor: session.metadata?.flavor ?? null,
        state,
        ...(!session.active && { activeAt: session.activeAt, createdAt: session.createdAt }),
        hasDraft: !!session.draft,
        active: session.active,
        machineId: session.metadata?.machineId ?? null,
        path: session.metadata?.path ?? null,
        homeDir: session.metadata?.homeDir ?? null,
        completedTodosCount: session.todos?.filter(todo => todo.status === 'completed').length ?? 0,
        totalTodosCount: session.todos?.length ?? 0,
        hasUnread: unreadSessionIds?.has(session.id) ?? false,
    };
}

// Unified list item type for SessionsList component
export type SessionListViewItem =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: SessionRowData[] }
    | { type: 'archive-toggle'; hidden: boolean }
    | { type: 'project-group'; displayPath: string; machine: Machine }
    | { type: 'session'; session: SessionRowData };

// Compatibility list consumed by machine and new-session selectors.
export type SessionListItem = string | Session;

export type SessionApplyContext = {
    source: 'live' | 'hydration';
    /**
     * Hydration may display legacy state, but only a state whose session,
     * field, and version binding authenticated may enter reducer/lifecycle
     * processing. Live callers must retain authenticated provenance as well.
     */
    effectfulAgentStateSessionIds?: ReadonlySet<string>;
    /** Same boundary for metadata used by Git, voice, lifecycle, and send paths. */
    effectfulMetadataSessionIds?: ReadonlySet<string>;
};

interface StorageState {
    settings: Settings;
    settingsVersion: number | null;
    localSettings: LocalSettings;
    purchases: Purchases;
    profile: Profile;
    sessions: Record<string, Session>;
    sessionsData: SessionListItem[] | null;
    sessionListViewData: SessionListViewItem[] | null;
    sessionMessages: Record<string, SessionMessages>;
    pathGitStatus: Record<string, GitStatus | null>;        // keyed by "machineId:path"
    pathGitStatusFiles: Record<string, GitStatusFiles | null>; // keyed by "machineId:path"
    pathProjectFiles: Record<string, ProjectFilesList | null>;  // keyed by "machineId:path"
    sessionFileCache: Record<string, Record<string, { content: string | null; diff: string | null; isBinary: boolean; cachedAt: number }>>;
    machines: Record<string, Machine>;
    artifacts: Record<string, DecryptedArtifact>;  // New artifacts storage
    realtimeStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    realtimeMode: 'idle' | 'agent-speaking' | 'user-speaking';
    voiceSessionGeneration: number;
    socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    socketLastConnectedAt: number | null;
    socketLastDisconnectedAt: number | null;
    // Diagnostic fields populated from apiSocket's error/reconnect events. Used by the
    // ConnectionStatusDetailSheet so users (and self-hosters) can see WHY the connection
    // failed without having to dig through dev logs. Set to null when no error has occurred.
    socketLastErrorMessage: string | null;
    socketLastErrorAt: number | null;
    socketReconnectAttempts: number;
    isDataReady: boolean;
    nativeUpdateStatus: { available: boolean; updateUrl?: string } | null;
    applySessions: (
        sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[],
        context?: SessionApplyContext,
    ) => void;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
    deleteMachine: (machineId: string) => void;
    applyLoaded: () => void;
    applyReady: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => { changed: string[], hasReadyEvent: boolean };
    applyMessagesLoaded: (sessionId: string) => void;
    applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => void;
    applyOlderMessagesLoading: (sessionId: string, isLoading: boolean) => void;
    applySettings: (settings: Settings, version: number) => void;
    applySettingsLocal: (settings: Partial<Settings>) => void;
    applyLocalSettings: (settings: Partial<LocalSettings>) => void;
    applyPurchases: (customerInfo: CustomerInfo) => void;
    applyProfile: (profile: Profile) => void;
    applyGitStatus: (pathKey: string, status: GitStatus | null) => void;
    applyGitStatusFiles: (pathKey: string, files: GitStatusFiles | null) => void;
    applyProjectFiles: (pathKey: string, files: ProjectFilesList | null) => void;
    getSessionPathKey: (sessionId: string) => string | null;
    applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean) => void;
    applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => void;
    isMutableToolCall: (sessionId: string, callId: string) => boolean;
    setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => void;
    clearRealtimeModeDebounce: () => void;
    incrementVoiceSessionGeneration: () => void;
    setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void;
    setSocketDetails: (details: { lastErrorMessage?: string | null; reconnectAttempts?: number }) => void;
    // One recoverable failed-message draft per session, cleared by retry,
    // discard, or a successful flush.
    failedMessageDrafts: Record<string, FailedMessageDraft>;
    setFailedMessageDraft: (sessionId: string, draft: FailedMessageDraft | null) => void;
    getActiveSessions: () => Session[];
    updateSessionDraft: (sessionId: string, draft: string | null) => void;
    updateSessionPermissionMode: (sessionId: string, mode: string | null) => void;
    updateSessionModelMode: (sessionId: string, mode: string | null) => void;
    updateSessionEffortLevel: (sessionId: string, level: string | null) => void;
    resetSessionAgentOverrides: (sessionId: string) => void;
    updateSessionThinking: (sessionId: string, thinking: boolean) => void;
    // Artifact methods
    applyArtifacts: (artifacts: DecryptedArtifact[]) => void;
    addArtifact: (artifact: DecryptedArtifact) => void;
    updateArtifact: (artifact: DecryptedArtifact) => void;
    deleteArtifact: (artifactId: string) => void;
    deleteSession: (sessionId: string) => void;
    // Unread session tracking (memory-only)
    unreadSessionIds: Set<string>;
    currentViewingSessionId: string | null;
    markSessionRead: (sessionId: string) => void;
    markSessionUnread: (sessionId: string) => void;
    setCurrentViewingSession: (sessionId: string | null) => void;
}

// Helper function to build unified list view data from sessions and machines
function buildSessionListViewData(
    sessions: Record<string, Session>,
    unreadSessionIds?: Set<string>,
): SessionListViewItem[] {
    // Separate active and inactive sessions
    const activeSessions: Session[] = [];
    const inactiveSessions: Session[] = [];

    Object.values(sessions).forEach(session => {
        if (isSessionActive(session)) {
            activeSessions.push(session);
        } else {
            inactiveSessions.push(session);
        }
    });

    // Sort by creation date (newest first) — matches applySessions behavior
    activeSessions.sort((a, b) => b.createdAt - a.createdAt);
    inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

    // Build unified list view data
    const listData: SessionListViewItem[] = [];

    // Add active sessions as a single item at the top (if any)
    if (activeSessions.length > 0) {
        listData.push({ type: 'active-sessions', sessions: activeSessions.map(s => buildSessionRowData(s, unreadSessionIds)) });
    }

    // Group inactive sessions by date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    let currentDateGroup: Session[] = [];
    let currentDateString: string | null = null;

    for (const session of inactiveSessions) {
        const sessionDate = new Date(session.createdAt);
        const dateString = sessionDate.toDateString();

        if (currentDateString !== dateString) {
            // Process previous group
            if (currentDateGroup.length > 0 && currentDateString) {
                const groupDate = new Date(currentDateString);
                const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

                let headerTitle: string;
                if (sessionDateOnly.getTime() === today.getTime()) {
                    headerTitle = 'Today';
                } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
                    headerTitle = 'Yesterday';
                } else {
                    const diffTime = today.getTime() - sessionDateOnly.getTime();
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    headerTitle = `${diffDays} days ago`;
                }

                listData.push({ type: 'header', title: headerTitle });
                currentDateGroup.forEach(sess => {
                    listData.push({ type: 'session', session: buildSessionRowData(sess, unreadSessionIds) });
                });
            }

            // Start new group
            currentDateString = dateString;
            currentDateGroup = [session];
        } else {
            currentDateGroup.push(session);
        }
    }

    // Process final group
    if (currentDateGroup.length > 0 && currentDateString) {
        const groupDate = new Date(currentDateString);
        const sessionDateOnly = new Date(groupDate.getFullYear(), groupDate.getMonth(), groupDate.getDate());

        let headerTitle: string;
        if (sessionDateOnly.getTime() === today.getTime()) {
            headerTitle = 'Today';
        } else if (sessionDateOnly.getTime() === yesterday.getTime()) {
            headerTitle = 'Yesterday';
        } else {
            const diffTime = today.getTime() - sessionDateOnly.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            headerTitle = `${diffDays} days ago`;
        }

        listData.push({ type: 'header', title: headerTitle });
        currentDateGroup.forEach(sess => {
            listData.push({ type: 'session', session: buildSessionRowData(sess, unreadSessionIds) });
        });
    }

    return listData;
}

export const storage = create<StorageState>()((set, get) => {
    let { settings, version } = loadSettings();
    let localSettings = loadLocalSettings();
    let purchases = loadPurchases();
    let profile = loadProfile();
    let sessionDrafts = loadSessionDrafts();
    let sessionPermissionModes = loadSessionPermissionModes();
    let sessionModelModes = loadSessionModelModes();
    let sessionEffortLevels = loadSessionEffortLevels();
    return {
        settings,
        settingsVersion: version,
        localSettings,
        purchases,
        profile,
        sessions: {},
        machines: {},
        artifacts: {},  // Initialize artifacts
        sessionsData: null,
        sessionListViewData: null,
        sessionMessages: {},
        pathGitStatus: {},
        pathGitStatusFiles: {},
        pathProjectFiles: {},
        sessionFileCache: {},
        realtimeStatus: 'disconnected',
        realtimeMode: 'idle',
        voiceSessionGeneration: 0,
        socketStatus: 'disconnected',
        socketLastConnectedAt: null,
        socketLastDisconnectedAt: null,
        socketLastErrorMessage: null,
        socketLastErrorAt: null,
        socketReconnectAttempts: 0,
        failedMessageDrafts: {},
        setFailedMessageDraft: (sessionId: string, draft: FailedMessageDraft | null) => set((state) => {
            const next = { ...state.failedMessageDrafts };
            if (draft) {
                next[sessionId] = draft;
                saveSessionFailedMessage(sessionId, draft);
            } else {
                delete next[sessionId];
                clearSessionFailedMessage(sessionId);
            }
            return { failedMessageDrafts: next };
        }),
        isDataReady: false,
        nativeUpdateStatus: null,
        unreadSessionIds: new Set<string>(),
        currentViewingSessionId: null,
        isMutableToolCall: (sessionId: string, callId: string) => {
            const sessionMessages = get().sessionMessages[sessionId];
            if (!sessionMessages) {
                return true;
            }
            const toolCall = sessionMessages.reducerState.toolIdToMessageId.get(callId);
            if (!toolCall) {
                return true;
            }
            const toolCallMessage = sessionMessages.messagesMap[toolCall];
            if (!toolCallMessage || toolCallMessage.kind !== 'tool-call') {
                return true;
            }
            return toolCallMessage.tool?.name ? isMutableTool(toolCallMessage.tool?.name) : true;
        },
        getActiveSessions: () => {
            const state = get();
            return Object.values(state.sessions).filter(s => s.active);
        },
        applySessions: (
            sessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[],
            context: SessionApplyContext = { source: 'live' },
        ) => set((state) => {
            // Load drafts and permission modes if sessions are empty (initial load)
            const isInitialLoad = Object.keys(state.sessions).length === 0;
            const savedDrafts = isInitialLoad ? sessionDrafts : {};
            const savedPermissionModes = isInitialLoad ? sessionPermissionModes : {};
            const savedModelModes = isInitialLoad ? sessionModelModes : {};
            const savedEffortLevels = isInitialLoad ? sessionEffortLevels : {};

            // Hydrate persisted failed-message drafts during the initial session load.
            const hydratedFailedDrafts: Record<string, FailedMessageDraft> = { ...state.failedMessageDrafts };
            for (const session of sessions) {
                if (hydratedFailedDrafts[session.id]) continue;
                const cached = loadSessionFailedMessage(session.id);
                if (cached) {
                    hydratedFailedDrafts[session.id] = cached;
                }
            }

            // Merge new sessions with existing ones
            const mergedSessions: Record<string, Session> = { ...state.sessions };

            // Update sessions with calculated presence using centralized resolver
            sessions.forEach(session => {
                // Use centralized resolver for consistent state management
                const presence = resolveSessionOnlineState(session);

                // Preserve explicit local overrides if they exist, or load from
                // saved data. Missing/null means "no user override"; the UI and
                // CLI resolve code defaults later.
                const existingDraft = state.sessions[session.id]?.draft;
                const savedDraft = savedDrafts[session.id];
                const savedPermissionMode = savedPermissionModes[session.id] ?? null;
                const existingPermissionModeRaw = state.sessions[session.id]?.permissionMode ?? null;
                const existingPermissionMode = existingPermissionModeRaw === 'default' && savedPermissionMode !== 'default'
                    ? null
                    : existingPermissionModeRaw;
                const resolvedPermissionMode = existingPermissionMode ?? savedPermissionMode ?? session.permissionMode ?? null;

                // Restore local-only model mode and effort selections from MMKV
                // because the relay does not synchronize these preferences.
                const savedModelMode = savedModelModes[session.id] ?? null;
                const existingModelModeRaw = state.sessions[session.id]?.modelMode ?? null;
                const existingModelMode = existingModelModeRaw === 'default' && savedModelMode !== 'default'
                    ? null
                    : existingModelModeRaw;
                const resolvedModelMode = existingModelMode ?? savedModelMode ?? session.modelMode ?? null;
                const existingEffortLevel = state.sessions[session.id]?.effortLevel ?? null;
                const resolvedEffortLevel = existingEffortLevel ?? savedEffortLevels[session.id] ?? session.effortLevel ?? null;

                // ENSO-3: hydrate latestUsage from the mmkv cache if the server
                // response didn't include it AND we don't already have it in state.
                // Without this, the Ensō ring is hidden during the fetch window after
                // iOS app eviction → tab-back, until messages stream in and the reducer
                // catches up.
                const cachedLatestUsage = !session.latestUsage && !state.sessions[session.id]?.latestUsage
                    ? loadSessionLatestUsage(session.id)
                    : null;

                const retainedAgentState = retainAgentStateWithinBudget(session.agentState);
                const agentStateIsAuthenticated = context.effectfulAgentStateSessionIds?.has(session.id) === true
                    || isAgentStateAuthenticatedForEffects(session.agentState);
                const metadataIsAuthenticated = context.effectfulMetadataSessionIds?.has(session.id) === true
                    || isMetadataAuthenticatedForEffects(session.metadata);

                mergedSessions[session.id] = {
                    ...session,
                    agentState: retainedAgentState,
                    presence,
                    draft: existingDraft || savedDraft || session.draft || null,
                    permissionMode: resolvedPermissionMode,
                    modelMode: resolvedModelMode,
                    effortLevel: resolvedEffortLevel,
                    latestUsage: session.latestUsage ?? state.sessions[session.id]?.latestUsage ?? cachedLatestUsage ?? null,
                };
                if (agentStateIsAuthenticated) {
                    markAgentStateAuthenticatedForEffects(retainedAgentState);
                }
                if (metadataIsAuthenticated) {
                    markMetadataAuthenticatedForEffects(mergedSessions[session.id].metadata);
                }
            });

            // Build active set from all sessions (including existing ones)
            const activeSet = new Set<string>();
            Object.values(mergedSessions).forEach(session => {
                if (isSessionActive(session)) {
                    activeSet.add(session.id);
                }
            });

            // Separate active and inactive sessions
            const activeSessions: Session[] = [];
            const inactiveSessions: Session[] = [];

            // Process all sessions from merged set
            Object.values(mergedSessions).forEach(session => {
                if (activeSet.has(session.id)) {
                    activeSessions.push(session);
                } else {
                    inactiveSessions.push(session);
                }
            });

            // Sort both arrays by creation date for stable ordering
            activeSessions.sort((a, b) => b.createdAt - a.createdAt);
            inactiveSessions.sort((a, b) => b.createdAt - a.createdAt);

            // Build flat list data for FlashList
            const listData: SessionListItem[] = [];

            if (activeSessions.length > 0) {
                listData.push('online');
                listData.push(...activeSessions);
            }

            // Retain the flat compatibility list for machine and new-session selectors.

            if (inactiveSessions.length > 0) {
                listData.push('offline');
                listData.push(...inactiveSessions);
            }

            // Process AgentState updates for sessions that already have messages loaded
            const updatedSessionMessages = { ...state.sessionMessages };

            sessions.forEach(session => {
                const oldSession = state.sessions[session.id];
                const newSession = mergedSessions[session.id];

                // Check if sessionMessages exists AND agentStateVersion is newer
                const existingSessionMessages = updatedSessionMessages[session.id];
                const agentStateIsEffectful = isAgentStateAuthenticatedForEffects(newSession.agentState);
                if (agentStateIsEffectful && existingSessionMessages && newSession.agentState &&
                    (!oldSession || newSession.agentStateVersion > (oldSession.agentStateVersion || 0))) {
                    // Process new AgentState through reducer
                    const reducerResult = reducer(existingSessionMessages.reducerState, [], newSession.agentState);
                    const processedMessages = reducerResult.messages;

                    // Always update the session messages, even if no new messages were created
                    // This ensures the reducer state is updated with the new AgentState
                    const mergedMessagesMap = { ...existingSessionMessages.messagesMap };
                    processedMessages.forEach(message => {
                        mergedMessagesMap[message.id] = message;
                    });

                    const retainedMessages = retainRecentSessionMessages(mergedMessagesMap);
                    const retainedReducerIds = pruneReducerState(
                        existingSessionMessages.reducerState,
                        retainedMessages.messages,
                    );
                    const boundedMessages = filterRetainedSessionMessages(
                        retainedMessages.messages,
                        retainedReducerIds,
                    );
                    const retainedToolIds = new Set([
                        ...existingSessionMessages.reducerState.toolIdToMessageId.keys(),
                        ...existingSessionMessages.reducerState.sidechainToolIdToMessageId.keys(),
                    ]);
                    const retainedEffectfulAgentState = retainAgentStateWithinBudget(
                        newSession.agentState,
                        retainedToolIds,
                    );
                    mergedSessions[session.id] = {
                        ...mergedSessions[session.id],
                        agentState: retainedEffectfulAgentState,
                    };
                    markAgentStateAuthenticatedForEffects(retainedEffectfulAgentState);

                    updatedSessionMessages[session.id] = {
                        messages: boundedMessages.messages,
                        messagesMap: boundedMessages.messagesMap,
                        reducerState: existingSessionMessages.reducerState, // The reducer modifies state in-place, so this has the updates
                        isLoaded: existingSessionMessages.isLoaded,
                        hasMoreOlder: existingSessionMessages.hasMoreOlder,
                        isLoadingOlder: existingSessionMessages.isLoadingOlder
                    };

                    // IMPORTANT: Copy latestUsage from reducerState to Session for immediate availability
                    if (existingSessionMessages.reducerState.latestUsage) {
                        mergedSessions[session.id] = {
                            ...mergedSessions[session.id],
                            latestUsage: { ...existingSessionMessages.reducerState.latestUsage }
                        };
                        // ENSO-3: also persist so we can rehydrate after iOS app eviction
                        saveSessionLatestUsage(session.id, existingSessionMessages.reducerState.latestUsage);
                    }
                }
            });

            // Track unread: detect when agent finishes all work for a request.
            // "Was active" = thinking or had pending permission requests.
            // "Now idle" = online, not thinking, no pending permissions.
            let unreadSessionIds = state.unreadSessionIds;
            sessions.forEach(session => {
                if (!isAgentStateAuthenticatedForEffects(mergedSessions[session.id]?.agentState)) {
                    return;
                }
                const oldSession = state.sessions[session.id];
                if (!oldSession) return;
                if (!isAgentStateAuthenticatedForEffects(oldSession.agentState)) return;
                const wasActive = oldSession.thinking === true
                    || (oldSession.agentState?.requests && Object.keys(oldSession.agentState.requests).length > 0);
                const newSession = mergedSessions[session.id];
                if (!newSession || !wasActive) return;
                const isNowIdle = newSession.thinking !== true
                    && newSession.presence === 'online'
                    && (!newSession.agentState?.requests || Object.keys(newSession.agentState.requests).length === 0);
                if (isNowIdle && state.currentViewingSessionId !== session.id) {
                    if (!unreadSessionIds.has(session.id)) {
                        unreadSessionIds = new Set(unreadSessionIds);
                        unreadSessionIds.add(session.id);
                    }
                }
            });

            // Build new unified list view data
            const sessionListViewData = buildSessionListViewData(
                mergedSessions,
                unreadSessionIds,
            );

            return {
                ...state,
                sessions: mergedSessions,
                sessionsData: listData,
                sessionListViewData,
                sessionMessages: updatedSessionMessages,
                failedMessageDrafts: hydratedFailedDrafts,
                unreadSessionIds,
            };
        }),
        applyLoaded: () => set((state) => {
            const result = {
                ...state,
                sessionsData: []
            };
            return result;
        }),
        applyReady: () => set((state) => ({
            ...state,
            isDataReady: true
        })),
        applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
            let changed = new Set<string>();
            let hasReadyEvent = false;

            // Track plan mode transitions through the batch in order.
            // Set true on EnterPlanMode, false on ExitPlanMode. The final value
            // tells us whether the batch ends with an unresolved plan entry.
            // This prevents history replays (which contain both Enter + Exit) from
            // re-triggering plan mode, while still catching real-time EnterPlanMode.
            let shouldEnterPlanMode = false;
            for (const msg of messages) {
                if (msg.role === 'agent') {
                    for (const c of msg.content) {
                        if (c.type === 'tool-call') {
                            if (c.name === 'EnterPlanMode' || c.name === 'enter_plan_mode') {
                                shouldEnterPlanMode = true;
                            } else if (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode') {
                                shouldEnterPlanMode = false;
                            }
                        }
                    }
                }
            }

            set((state) => {

                // Resolve session messages state
                const existingSession: SessionMessages = state.sessionMessages[sessionId] || {
                    messages: [],
                    messagesMap: {},
                    reducerState: createReducer(),
                    isLoaded: false,
                    hasMoreOlder: false,
                    isLoadingOlder: false
                };

                // Get the session's agentState if available
                const session = state.sessions[sessionId];
                const agentState = isAgentStateAuthenticatedForEffects(session?.agentState)
                    ? session?.agentState
                    : undefined;

                // Messages are already normalized, no need to process them again
                const normalizedMessages = messages;

                // Run reducer with agentState
                const reducerResult = reducer(existingSession.reducerState, normalizedMessages, agentState);
                const processedMessages = reducerResult.messages;
                for (let message of processedMessages) {
                    changed.add(message.id);
                }
                if (reducerResult.hasReadyEvent) {
                    hasReadyEvent = true;
                }

                // Merge messages
                const mergedMessagesMap = { ...existingSession.messagesMap };
                processedMessages.forEach(message => {
                    mergedMessagesMap[message.id] = message;
                });

                // Keep a bounded newest-first window so a malicious or very
                // long relay history cannot grow client memory indefinitely.
                const retainedMessages = retainRecentSessionMessages(mergedMessagesMap);
                const retainedReducerIds = pruneReducerState(
                    existingSession.reducerState,
                    retainedMessages.messages,
                );
                const boundedMessages = filterRetainedSessionMessages(
                    retainedMessages.messages,
                    retainedReducerIds,
                );

                // Update session with todos and latestUsage
                // IMPORTANT: We extract latestUsage from the mutable reducerState and copy it to the Session object
                // This ensures latestUsage is available immediately on load, even before messages are fully loaded
                let updatedSessions = state.sessions;
                const needsUpdate = (reducerResult.todos !== undefined || existingSession.reducerState.latestUsage || shouldEnterPlanMode) && session;

                if (needsUpdate) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            ...(reducerResult.todos !== undefined && { todos: reducerResult.todos }),
                            // Copy latestUsage from reducerState to make it immediately available
                            latestUsage: existingSession.reducerState.latestUsage ? {
                                ...existingSession.reducerState.latestUsage
                            } : session.latestUsage,
                            // Auto-switch to plan mode when EnterPlanMode tool call is detected
                            ...(shouldEnterPlanMode && { permissionMode: 'plan' })
                        }
                    };
                    // ENSO-3: persist for survival across iOS app eviction
                    if (existingSession.reducerState.latestUsage) {
                        saveSessionLatestUsage(sessionId, existingSession.reducerState.latestUsage);
                    }
                }

                return {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            messages: boundedMessages.messages,
                            messagesMap: boundedMessages.messagesMap,
                            reducerState: existingSession.reducerState, // Explicitly include the mutated reducer state
                            isLoaded: true
                        }
                    }
                };
            });

            // Persist plan mode change
            if (shouldEnterPlanMode) {
                const allModes: Record<string, string> = {};
                const currentState = get();
                Object.entries(currentState.sessions).forEach(([id, sess]) => {
                    if (sess.permissionMode && sess.permissionMode !== 'default') {
                        allModes[id] = sess.permissionMode;
                    }
                });
                saveSessionPermissionModes(allModes);
            }

            return { changed: Array.from(changed), hasReadyEvent };
        },
        applyMessagesLoaded: (sessionId: string) => set((state) => {
            const existingSession = state.sessionMessages[sessionId];
            let result: StorageState;

            if (!existingSession) {
                // First time loading - check for AgentState
                const session = state.sessions[sessionId];
                const displayAgentState = session?.agentState;
                const agentState = isAgentStateAuthenticatedForEffects(displayAgentState)
                    ? displayAgentState
                    : undefined;

                // Create new reducer state
                const reducerState = createReducer();

                // Process AgentState if it exists
                let messages: Message[] = [];
                let messagesMap: Record<string, Message> = {};
                let retainedAgentState = displayAgentState ?? null;

                if (agentState) {
                    // Process AgentState through reducer to get initial permission messages
                    const reducerResult = reducer(reducerState, [], agentState);
                    const processedMessages = reducerResult.messages;

                    processedMessages.forEach(message => {
                        messagesMap[message.id] = message;
                    });

                    const retainedMessages = retainRecentSessionMessages(messagesMap);
                    const retainedReducerIds = pruneReducerState(reducerState, retainedMessages.messages);
                    const boundedMessages = filterRetainedSessionMessages(
                        retainedMessages.messages,
                        retainedReducerIds,
                    );
                    messages = boundedMessages.messages;
                    messagesMap = boundedMessages.messagesMap;
                    retainedAgentState = retainAgentStateWithinBudget(agentState, new Set([
                        ...reducerState.toolIdToMessageId.keys(),
                        ...reducerState.sidechainToolIdToMessageId.keys(),
                    ]));
                    markAgentStateAuthenticatedForEffects(retainedAgentState);
                }

                // Extract latestUsage from reducerState if available and update session
                let updatedSessions = state.sessions;
                if (session) {
                    updatedSessions = {
                        ...state.sessions,
                        [sessionId]: {
                            ...session,
                            agentState: retainedAgentState,
                            ...(reducerState.latestUsage
                                ? { latestUsage: { ...reducerState.latestUsage } }
                                : {}),
                        }
                    };
                    if (reducerState.latestUsage) {
                        // ENSO-3: persist for survival across iOS app eviction
                        saveSessionLatestUsage(sessionId, reducerState.latestUsage);
                    }
                }

                result = {
                    ...state,
                    sessions: updatedSessions,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            reducerState,
                            messages,
                            messagesMap,
                            isLoaded: true,
                            hasMoreOlder: false,
                            isLoadingOlder: false
                        } satisfies SessionMessages
                    }
                };
            } else {
                result = {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [sessionId]: {
                            ...existingSession,
                            isLoaded: true
                        } satisfies SessionMessages
                    }
                };
            }

            return result;
        }),
        applyOlderMessagesPagination: (sessionId: string, info: { hasMore: boolean }) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) {
                // Pagination metadata is only meaningful once the session has
                // a SessionMessages entry. The fetch path always creates one
                // through applyMessages / applyMessagesLoaded before calling
                // this — but if for any reason it hasn't, ignore the update
                // rather than synthesize a partial entry.
                return state;
            }
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existing,
                        hasMoreOlder: info.hasMore
                    } satisfies SessionMessages
                }
            };
        }),
        applyOlderMessagesLoading: (sessionId: string, isLoading: boolean) => set((state) => {
            const existing = state.sessionMessages[sessionId];
            if (!existing) {
                return state;
            }
            if (existing.isLoadingOlder === isLoading) {
                return state;
            }
            return {
                ...state,
                sessionMessages: {
                    ...state.sessionMessages,
                    [sessionId]: {
                        ...existing,
                        isLoadingOlder: isLoading
                    } satisfies SessionMessages
                }
            };
        }),
        applySettingsLocal: (settings: Partial<Settings>) => set((state) => {
            saveSettings(applySettings(state.settings, settings), state.settingsVersion ?? 0);
            return {
                ...state,
                settings: applySettings(state.settings, settings)
            };
        }),
        applySettings: (settings: Settings, version: number) => set((state) => {
            if (state.settingsVersion === null || state.settingsVersion < version) {
                saveSettings(settings, version);
                return {
                    ...state,
                    settings,
                    settingsVersion: version
                };
            } else {
                return state;
            }
        }),
        applyLocalSettings: (delta: Partial<LocalSettings>) => set((state) => {
            const updatedLocalSettings = applyLocalSettings(state.localSettings, delta);
            saveLocalSettings(updatedLocalSettings);
            return {
                ...state,
                localSettings: updatedLocalSettings
            };
        }),
        applyPurchases: (customerInfo: CustomerInfo) => set((state) => {
            // Transform CustomerInfo to our Purchases format
            const purchases = customerInfoToPurchases(customerInfo);

            // Always save and update - no need for version checks
            savePurchases(purchases);
            return {
                ...state,
                purchases
            };
        }),
        applyProfile: (profile: Profile) => set((state) => {
            // Always save and update profile
            saveProfile(profile);
            return {
                ...state,
                profile
            };
        }),
        applyGitStatus: (pathKey: string, status: GitStatus | null) => set((state) => ({
            ...state,
            pathGitStatus: {
                ...state.pathGitStatus,
                [pathKey]: status
            }
        })),
        applyGitStatusFiles: (pathKey: string, files: GitStatusFiles | null) => set((state) => {
            // Short-circuit on no-op writes. gitStatusSync.invalidate fires on every
            // mutable-tool message and on every update-session, but most of those
            // don't actually change the file set. Without this guard, every fetch
            // produces a fresh object reference, the useSessionGitStatusFiles
            // subscription fires, and AllFilesDiffView nukes its scroll position
            // and re-runs every git diff. fast-deep-equal handles arrays + nested
            // objects so we don't have to enumerate fields.
            if (equal(state.pathGitStatusFiles[pathKey] ?? null, files)) {
                return state;
            }
            return {
                ...state,
                pathGitStatusFiles: {
                    ...state.pathGitStatusFiles,
                    [pathKey]: files
                }
            };
        }),
        applyProjectFiles: (pathKey: string, files: ProjectFilesList | null) => set((state) => ({
            ...state,
            pathProjectFiles: {
                ...state.pathProjectFiles,
                [pathKey]: files
            }
        })),
        applyFileCache: (sessionId: string, filePath: string, content: string | null, diff: string | null, isBinary: boolean) => set((state) => {
            const sessionEntries = {
                ...(state.sessionFileCache[sessionId] || {}),
                [filePath]: { content, diff, isBinary, cachedAt: Date.now() }
            };
            return {
                ...state,
                sessionFileCache: limitAllSessionFileCaches({
                    ...state.sessionFileCache,
                    [sessionId]: sessionEntries,
                }),
            };
        }),
        applyNativeUpdateStatus: (status: { available: boolean; updateUrl?: string } | null) => set((state) => ({
            ...state,
            nativeUpdateStatus: status
        })),
        setRealtimeStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => ({
            ...state,
            realtimeStatus: status
        })),
        setRealtimeMode: (mode: 'idle' | 'agent-speaking' | 'user-speaking', immediate?: boolean) => {
            if (immediate) {
                // Clear any pending debounce and set immediately
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                    realtimeModeDebounceTimer = null;
                }
                set((state) => ({ ...state, realtimeMode: mode }));
            } else {
                // Debounce mode changes to avoid flickering
                if (realtimeModeDebounceTimer) {
                    clearTimeout(realtimeModeDebounceTimer);
                }
                realtimeModeDebounceTimer = setTimeout(() => {
                    realtimeModeDebounceTimer = null;
                    set((state) => ({ ...state, realtimeMode: mode }));
                }, REALTIME_MODE_DEBOUNCE_MS);
            }
        },
        clearRealtimeModeDebounce: () => {
            if (realtimeModeDebounceTimer) {
                clearTimeout(realtimeModeDebounceTimer);
                realtimeModeDebounceTimer = null;
            }
        },
        incrementVoiceSessionGeneration: () => set((state) => ({
            ...state,
            voiceSessionGeneration: state.voiceSessionGeneration + 1
        })),
        setSocketStatus: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => set((state) => {
            const now = Date.now();
            const updates: Partial<StorageState> = {
                socketStatus: status
            };

            // Update timestamp based on status
            if (status === 'connected') {
                updates.socketLastConnectedAt = now;
                // Connected → clear reconnect-attempts + drop stale error so the detail sheet
                // doesn't keep showing "5 attempts" / "Last error" for a recovered session.
                updates.socketReconnectAttempts = 0;
                updates.socketLastErrorMessage = null;
                updates.socketLastErrorAt = null;
            } else if (status === 'disconnected' || status === 'error') {
                updates.socketLastDisconnectedAt = now;
            }

            return {
                ...state,
                ...updates
            };
        }),
        // Set diagnostic socket details independently of status. apiSocket emits these on
        // connect_error / reconnect_attempt to surface WHY a session disconnected without
        // overloading the status enum. Passing `undefined` for a field leaves it unchanged.
        setSocketDetails: (details: { lastErrorMessage?: string | null; reconnectAttempts?: number }) => set((state) => {
            const updates: Partial<StorageState> = {};
            if (details.lastErrorMessage !== undefined) {
                updates.socketLastErrorMessage = details.lastErrorMessage;
                updates.socketLastErrorAt = details.lastErrorMessage ? Date.now() : null;
            }
            if (details.reconnectAttempts !== undefined) {
                updates.socketReconnectAttempts = details.reconnectAttempts;
            }
            return { ...state, ...updates };
        }),
        updateSessionDraft: (sessionId: string, draft: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Don't store empty strings, convert to null
            const normalizedDraft = draft?.trim() ? draft : null;

            // Collect all drafts for persistence
            const allDrafts: Record<string, string> = {};
            Object.entries(state.sessions).forEach(([id, sess]) => {
                if (id === sessionId) {
                    if (normalizedDraft) {
                        allDrafts[id] = normalizedDraft;
                    }
                } else if (sess.draft) {
                    allDrafts[id] = sess.draft;
                }
            });

            // Persist drafts
            saveSessionDrafts(allDrafts);

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    draft: normalizedDraft
                }
            };

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData: buildSessionListViewData(updatedSessions)
            };
        }),
        updateSessionPermissionMode: (sessionId: string, mode: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new permission mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: mode
                }
            };

            // Collect all permission modes for persistence
            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode) {
                    allModes[id] = sess.permissionMode;
                }
            });

            // Persist only explicit overrides; null/missing means code default.
            saveSessionPermissionModes(allModes);

            // No need to rebuild sessionListViewData since permission mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionThinking: (sessionId: string, thinking: boolean) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            if (session.thinking === thinking) return state;

            // ABORT-1: sessionAbort calls this to optimistically clear `thinking`
            // so the "Conjuring…" indicator and Abort button disappear the instant
            // the user taps Abort, instead of waiting for the CLI's stop update
            // (which can lag or, on a flaky link, never arrive). A later server
            // update re-syncs the real value either way.
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    thinking
                }
            };

            // `thinking` drives the session status (indicator + list status dot),
            // so rebuild the list view data for an immediate UI update.
            const sessionListViewData = buildSessionListViewData(updatedSessions);

            return {
                ...state,
                sessions: updatedSessions,
                sessionListViewData
            };
        }),
        updateSessionModelMode: (sessionId: string, mode: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            // Update the session with the new model mode
            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    modelMode: mode
                }
            };

            // Persist only explicit overrides; null/missing means code default.
            const allModes: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.modelMode) {
                    allModes[id] = sess.modelMode;
                }
            });
            saveSessionModelModes(allModes);

            // No need to rebuild sessionListViewData since model mode doesn't affect the list display
            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        updateSessionEffortLevel: (sessionId: string, level: string | null) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    effortLevel: level
                }
            };

            // Persist effort levels so the selection survives app restart.
            const allLevels: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.effortLevel) {
                    allLevels[id] = sess.effortLevel;
                }
            });
            saveSessionEffortLevels(allLevels);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        resetSessionAgentOverrides: (sessionId: string) => set((state) => {
            const session = state.sessions[sessionId];
            if (!session) return state;

            const updatedSessions = {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    permissionMode: null,
                    modelMode: null,
                    effortLevel: null,
                }
            };

            const permissionModes: Record<string, string> = {};
            const modelModes: Record<string, string> = {};
            const effortLevels: Record<string, string> = {};
            Object.entries(updatedSessions).forEach(([id, sess]) => {
                if (sess.permissionMode) permissionModes[id] = sess.permissionMode;
                if (sess.modelMode) modelModes[id] = sess.modelMode;
                if (sess.effortLevel) effortLevels[id] = sess.effortLevel;
            });
            saveSessionPermissionModes(permissionModes);
            saveSessionModelModes(modelModes);
            saveSessionEffortLevels(effortLevels);

            return {
                ...state,
                sessions: updatedSessions
            };
        }),
        getSessionPathKey: (sessionId: string): string | null => {
            const session = get().sessions[sessionId];
            const metadata = getOperationalSessionMetadata(session?.metadata);
            if (!metadata?.machineId || !metadata.path) return null;
            return `${metadata.machineId}:${metadata.path}`;
        },
        applyMachines: (machines: Machine[], replace: boolean = false) => set((state) => {
            // Either replace all machines or merge updates
            let mergedMachines: Record<string, Machine>;

            if (replace) {
                // Replace entire machine state (used by fetchMachines)
                mergedMachines = {};
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            } else {
                // Merge individual updates (used by update-machine)
                mergedMachines = { ...state.machines };
                machines.forEach(machine => {
                    mergedMachines[machine.id] = machine;
                });
            }

            // Rebuild sessionListViewData to reflect machine changes
            const sessionListViewData = buildSessionListViewData(
                state.sessions
            );

            return {
                ...state,
                machines: mergedMachines,
                sessionListViewData
            };
        }),
        deleteMachine: (machineId: string) => set((state) => {
            if (!state.machines[machineId]) {
                return state;
            }
            const { [machineId]: _removed, ...remaining } = state.machines;
            return {
                ...state,
                machines: remaining,
                sessionListViewData: buildSessionListViewData(state.sessions)
            };
        }),
        // Artifact methods
        applyArtifacts: (artifacts: DecryptedArtifact[]) => set((state) => {
            console.log('Storage is applying artifacts');
            const mergedArtifacts = { ...state.artifacts };
            artifacts.forEach(artifact => {
                mergedArtifacts[artifact.id] = artifact;
            });
            console.log('Storage applied artifacts');

            return {
                ...state,
                artifacts: mergedArtifacts
            };
        }),
        addArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };

            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        updateArtifact: (artifact: DecryptedArtifact) => set((state) => {
            const updatedArtifacts = {
                ...state.artifacts,
                [artifact.id]: artifact
            };

            return {
                ...state,
                artifacts: updatedArtifacts
            };
        }),
        deleteArtifact: (artifactId: string) => set((state) => {
            const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

            return {
                ...state,
                artifacts: remainingArtifacts
            };
        }),
        deleteSession: (sessionId: string) => set((state) => {
            // Remove session from sessions
            const { [sessionId]: deletedSession, ...remainingSessions } = state.sessions;

            // Remove session messages if they exist
            const { [sessionId]: deletedMessages, ...remainingSessionMessages } = state.sessionMessages;

            const { [sessionId]: _fileCache, ...remainingFileCache } = state.sessionFileCache;

            // Clear drafts, permission modes, model modes, effort levels from persistent storage
            const drafts = loadSessionDrafts();
            delete drafts[sessionId];
            saveSessionDrafts(drafts);

            const modes = loadSessionPermissionModes();
            delete modes[sessionId];
            saveSessionPermissionModes(modes);

            const modelModes = loadSessionModelModes();
            delete modelModes[sessionId];
            saveSessionModelModes(modelModes);

            const effortLevels = loadSessionEffortLevels();
            delete effortLevels[sessionId];
            saveSessionEffortLevels(effortLevels);

            // Rebuild sessionListViewData without the deleted session
            const sessionListViewData = buildSessionListViewData(remainingSessions);

            return {
                ...state,
                sessions: remainingSessions,
                sessionMessages: remainingSessionMessages,
                sessionFileCache: remainingFileCache,
                sessionListViewData
            };
        }),
        markSessionRead: (sessionId: string) => set((state) => {
            if (!state.unreadSessionIds.has(sessionId)) return state;
            const next = new Set(state.unreadSessionIds);
            next.delete(sessionId);
            return {
                ...state,
                unreadSessionIds: next,
                sessionListViewData: buildSessionListViewData(state.sessions, next),
            };
        }),
        markSessionUnread: (sessionId: string) => set((state) => {
            if (state.unreadSessionIds.has(sessionId)) return state;
            const next = new Set(state.unreadSessionIds);
            next.add(sessionId);
            return {
                ...state,
                unreadSessionIds: next,
                sessionListViewData: buildSessionListViewData(state.sessions, next),
            };
        }),
        setCurrentViewingSession: (sessionId: string | null) => set((state) => {
            if (state.currentViewingSessionId === sessionId) return state;
            // If switching to a new session, mark it as read
            const next = sessionId && state.unreadSessionIds.has(sessionId)
                ? (() => { const s = new Set(state.unreadSessionIds); s.delete(sessionId); return s; })()
                : state.unreadSessionIds;
            return {
                ...state,
                currentViewingSessionId: sessionId,
                unreadSessionIds: next,
                ...(next !== state.unreadSessionIds ? {
                    sessionListViewData: buildSessionListViewData(state.sessions, next),
                } : {}),
            };
        }),
    }
});

export function useSessions() {
    return storage(useShallow((state) => state.isDataReady ? state.sessionsData : null));
}

export function useSession(id: string): Session | null {
    return storage(useShallow((state) => state.sessions[id] ?? null));
}

const emptyArray: unknown[] = [];

export function useSessionMessages(sessionId: string): {
    messages: Message[],
    isLoaded: boolean,
    hasMoreOlder: boolean,
    isLoadingOlder: boolean
} {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return {
            messages: session?.messages ?? emptyArray,
            isLoaded: session?.isLoaded ?? false,
            hasMoreOlder: session?.hasMoreOlder ?? false,
            isLoadingOlder: session?.isLoadingOlder ?? false
        };
    }));
}

export function useMessage(sessionId: string, messageId: string): Message | null {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.messagesMap[messageId] ?? null;
    }));
}

export function useSessionUsage(sessionId: string) {
    return storage(useShallow((state) => {
        const session = state.sessionMessages[sessionId];
        return session?.reducerState?.latestUsage ?? null;
    }));
}

// Returns the session's recoverable failed-message draft, when present.
export function useFailedMessageDraft(sessionId: string): FailedMessageDraft | null {
    return storage(useShallow((state) => state.failedMessageDrafts[sessionId] ?? null));
}

export function useSettings(): Settings {
    return storage(useShallow((state) => state.settings));
}

export function useSettingMutable<K extends keyof Settings>(name: K): [Settings[K], (value: Settings[K]) => void] {
    const setValue = React.useCallback((value: Settings[K]) => {
        sync.applySettings({ [name]: value });
    }, [name]);
    const value = useSetting(name);
    return [value, setValue];
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
    return storage(useShallow((state) => state.settings[name]));
}

export function useLocalSettings(): LocalSettings {
    return storage(useShallow((state) => state.localSettings));
}

export function useAllMachines(options?: { includeOffline?: boolean }): Machine[] {
    const includeOffline = options?.includeOffline ?? false;
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        const machines = Object.values(state.machines).sort((a, b) => b.createdAt - a.createdAt);
        return includeOffline ? machines : machines.filter((v) => v.active);
    }));
}

export function useMachine(machineId: string): Machine | null {
    return storage(useShallow((state) => state.machines[machineId] ?? null));
}

export function useSessionListViewData(): SessionListViewItem[] | null {
    return storage(useDeepEqual((state) => state.isDataReady ? state.sessionListViewData : null));
}

export function useAllSessions(): Session[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        return Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useLocalSettingMutable<K extends keyof LocalSettings>(name: K): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const setValue = React.useCallback((value: LocalSettings[K]) => {
        storage.getState().applyLocalSettings({ [name]: value });
    }, [name]);
    const value = useLocalSetting(name);
    return [value, setValue];
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
    return storage(useShallow((state) => state.localSettings[name]));
}

export function useIsSessionUnread(sessionId: string): boolean {
    return storage((state) => state.unreadSessionIds.has(sessionId));
}

// Artifact hooks
export function useArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Filter out draft artifacts from the main list
        return Object.values(state.artifacts)
            .filter(artifact => !artifact.draft)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useAllArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return all artifacts including drafts
        return Object.values(state.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useDraftArtifacts(): DecryptedArtifact[] {
    return storage(useShallow((state) => {
        if (!state.isDataReady) return [];
        // Return only draft artifacts
        return Object.values(state.artifacts)
            .filter(artifact => artifact.draft === true)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }));
}

export function useArtifact(artifactId: string): DecryptedArtifact | null {
    return storage(useShallow((state) => state.artifacts[artifactId] ?? null));
}

export function useArtifactsCount(): number {
    return storage(useShallow((state) => {
        // Count only non-draft artifacts
        return Object.values(state.artifacts).filter(a => !a.draft).length;
    }));
}

export function useEntitlement(id: KnownEntitlements): boolean {
    return storage(useShallow((state) => state.purchases.entitlements[id] ?? false));
}

export function useRealtimeStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    return storage(useShallow((state) => state.realtimeStatus));
}

export function useRealtimeMode(): 'idle' | 'agent-speaking' | 'user-speaking' {
    return storage(useShallow((state) => state.realtimeMode));
}

export function useVoiceSessionGeneration(): number {
    return storage(useShallow((state) => state.voiceSessionGeneration));
}

export function useSocketStatus() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt
    })));
}

// Richer hook used by ConnectionStatusDetailSheet. Returns everything `useSocketStatus()` gives
// plus the diagnostic fields populated by apiSocket's error/reconnect handlers via
// `setSocketDetails`. Use this when the consumer needs the error message / reconnect counter
// (e.g., the tappable status sheet); use `useSocketStatus` for the simpler status-color use case.
export function useSocketDetails() {
    return storage(useShallow((state) => ({
        status: state.socketStatus,
        lastConnectedAt: state.socketLastConnectedAt,
        lastDisconnectedAt: state.socketLastDisconnectedAt,
        lastErrorMessage: state.socketLastErrorMessage,
        lastErrorAt: state.socketLastErrorAt,
        reconnectAttempts: state.socketReconnectAttempts
    })));
}

export function useSessionGitStatus(sessionId: string): GitStatus | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathGitStatus[pathKey] ?? null : null;
    }));
}

export function useSessionGitStatusFiles(sessionId: string): GitStatusFiles | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathGitStatusFiles[pathKey] ?? null : null;
    }));
}

export function useSessionProjectFiles(sessionId: string): ProjectFilesList | null {
    return storage(useShallow((state) => {
        const pathKey = state.getSessionPathKey(sessionId);
        return pathKey ? state.pathProjectFiles[pathKey] ?? null : null;
    }));
}

export function useSessionFileCache(sessionId: string, filePath: string) {
    return storage(useShallow((state) => state.sessionFileCache[sessionId]?.[filePath] ?? null));
}

export function useIsDataReady(): boolean {
    return storage(useShallow((state) => state.isDataReady));
}

export function useProfile() {
    return storage(useShallow((state) => state.profile));
}
