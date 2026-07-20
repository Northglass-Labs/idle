import { getCurrentRealtimeSessionId, getVoiceSession, isVoiceSessionStarted, setCurrentRealtimeSessionId } from '../RealtimeSession';
import {
    MAX_VOICE_SESSION_DIRECTORY_CHARS,
    formatNewMessages,
    formatPermissionRequest,
    formatReadyEvent,
    formatSessionDirectory,
    formatSessionFocus,
    formatSessionFull,
    formatSessionOffline,
    formatSessionOnline
} from './contextFormatters';
import {
    getOperationalAgentState,
    getOperationalSessionMetadata,
    storage,
} from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { Message } from '@/sync/typesMessage';
import { VOICE_CONFIG } from '../voiceConfig';
import {
    BoundedVoicePromptQueue,
    MAX_VOICE_CONTEXT_CHARS,
    boundVoiceText,
} from './voicePromptQueue';

/**
 * Centralized voice assistant hooks for multi-session context updates.
 *
 * Two update channels:
 * - sendContext()  → silent background injection (sendContextualUpdate), always immediate
 * - sendPrompt()  → triggers agent response (sendTextMessage), queued while anyone is speaking
 *
 * Prompt queue flushes automatically when realtimeMode transitions to 'idle'.
 */

interface SessionMetadata {
    summary?: { text?: string };
    path?: string;
    machineId?: string;
    [key: string]: any;
}

let shownSessions = new Set<string>();

// Prompt queue — batched text messages that trigger agent responses
const pendingPrompts = new BoundedVoicePromptQueue();

// Subscribe to realtimeMode changes to flush when idle
let unsubscribeMode: (() => void) | null = null;
let lastRealtimeMode: string | null = null;

function ensureModeSubscription() {
    if (unsubscribeMode) return;
    lastRealtimeMode = storage.getState().realtimeMode;
    unsubscribeMode = storage.subscribe((state) => {
        const mode = state.realtimeMode;
        if (mode !== lastRealtimeMode) {
            lastRealtimeMode = mode;
            if (mode === 'idle') {
                flushPendingPrompts();
            }
        }
    });
}

function flushPendingPrompts() {
    if (pendingPrompts.size === 0) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) {
        pendingPrompts.clear();
        return;
    }
    const batched = pendingPrompts.drain().join('\n\n');
    voice.sendTextMessage(boundVoiceText(batched, MAX_VOICE_CONTEXT_CHARS));
}

/**
 * Send silent background context — always immediate, never queued.
 */
function sendContext(update: string | null | undefined) {
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;
    voice.sendContextualUpdate(boundVoiceText(update, MAX_VOICE_CONTEXT_CHARS));
}

/**
 * Send a prompt that triggers an agent response.
 * Queued while anyone (user or agent) is speaking, flushed on idle.
 */
function sendPrompt(update: string | null | undefined) {
    if (!update) return;
    const voice = getVoiceSession();
    if (!voice || !isVoiceSessionStarted()) return;

    const mode = storage.getState().realtimeMode;
    if (mode === 'idle') {
        voice.sendTextMessage(boundVoiceText(update));
    } else {
        pendingPrompts.enqueue(update);
    }
}

function getOperationalVoiceSession(sessionId: string): Session | null {
    const session = storage.getState().sessions[sessionId];
    if (!session) return null;

    const metadata = getOperationalSessionMetadata(session.metadata);
    const agentState = getOperationalAgentState(session.agentState);
    if (!metadata && !agentState) return null;

    return {
        ...session,
        metadata,
        agentState,
    };
}

/**
 * Inject full context for a session if not already shown.
 * Shared code path for both voice start and session focus.
 * Returns the formatted string (for initial prompt building) or null if already shown.
 */
function injectSessionContext(
    sessionId: string,
    options: { includeSummary?: boolean; maxChars?: number } = {},
): string | null {
    if (shownSessions.has(sessionId)) return null;
    const session = getOperationalVoiceSession(sessionId);
    if (!session) return null;
    shownSessions.add(sessionId);
    const messages = storage.getState().sessionMessages[sessionId]?.messages ?? [];
    return formatSessionFull(session, messages, options);
}

export const voiceHooks = {

    /**
     * Called when a session comes online/connects
     */
    onSessionOnline(sessionId: string, _metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
        const session = getOperationalVoiceSession(sessionId);
        if (!session) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOnline(sessionId, session.metadata ?? undefined));
    },

    /**
     * Called when a session goes offline/disconnects
     */
    onSessionOffline(sessionId: string, _metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_STATUS) return;
        const session = getOperationalVoiceSession(sessionId);
        if (!session) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionOffline(sessionId, session.metadata ?? undefined));
    },

    /**
     * Called when user navigates to/views a session
     */
    onSessionFocus(sessionId: string, _metadata?: SessionMetadata) {
        if (VOICE_CONFIG.DISABLE_SESSION_FOCUS) return;
        if (getCurrentRealtimeSessionId() === sessionId) return;
        const session = getOperationalVoiceSession(sessionId);
        if (!session) return;
        setCurrentRealtimeSessionId(sessionId);
        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatSessionFocus(sessionId, session.metadata ?? undefined));
    },

    /**
     * Called when Claude requests permission for a tool use
     */
    onPermissionRequested(sessionId: string, requestId: string, toolName: string) {
        if (VOICE_CONFIG.DISABLE_PERMISSION_REQUESTS) return;
        const session = getOperationalVoiceSession(sessionId);
        if (!getOperationalAgentState(session?.agentState)?.requests?.[requestId]) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(formatPermissionRequest(sessionId, requestId, toolName));
    },

    /**
     * Called when agent sends a message/response
     */
    onMessages(sessionId: string, messages: Message[]) {
        if (VOICE_CONFIG.DISABLE_MESSAGES) return;
        if (!getOperationalVoiceSession(sessionId)) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendContext(formatNewMessages(sessionId, messages));
    },

    /**
     * Called when voice session starts.
     * Builds initial prompt with session directory + full current session context.
     */
    onVoiceStarted(sessionId: string): string {
        shownSessions.clear();
        pendingPrompts.clear();
        ensureModeSubscription();

        const activeSessions = storage.getState().getActiveSessions()
            .map((session) => getOperationalVoiceSession(session.id))
            .filter((session): session is Session => session !== null);
        const directory = formatSessionDirectory(activeSessions, sessionId);
        let prompt = directory + '\n\n';

        // Full context for the current session
        const ctx = injectSessionContext(sessionId, {
            // Avoid duplication when the current title is already in the
            // active-session directory, but keep it for an inactive current
            // session that is still locally available.
            includeSummary: !activeSessions.some((session) => session.id === sessionId),
            maxChars: MAX_VOICE_CONTEXT_CHARS - MAX_VOICE_SESSION_DIRECTORY_CHARS - 64,
        });
        if (ctx) {
            prompt += 'CURRENT SESSION:\n\n' + ctx;
        }

        return boundVoiceText(prompt, MAX_VOICE_CONTEXT_CHARS);
    },

    /**
     * Called when Claude Code finishes processing (ready event)
     */
    onReady(sessionId: string) {
        if (VOICE_CONFIG.DISABLE_READY_EVENTS) return;
        if (!getOperationalVoiceSession(sessionId)) return;

        const ctx = injectSessionContext(sessionId);
        if (ctx) sendContext(ctx);
        sendPrompt(formatReadyEvent(sessionId));
    },

    /**
     * Called when voice session stops
     */
    onVoiceStopped() {
        shownSessions.clear();
        pendingPrompts.clear();
    }
};
