import { z } from 'zod';
import { sync } from '@/sync/sync';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import {
    isAgentStateAuthenticatedForEffects,
    isMetadataAuthenticatedForEffects,
    storage,
} from '@/sync/storage';
import { trackVoicePermissionResponse } from '@/track';
import { getVoiceSession, isVoiceSessionStarted } from './RealtimeSession';
import {
    getVoiceMessageCount,
    incrementVoiceMessageCount,
} from '@/sync/persistence';
import { Modal } from '@/modal';
import { t } from '@/text';

const MAX_VOICE_TOOL_ID_LENGTH = 128;
const MAX_VOICE_MESSAGE_LENGTH = 1024;
const MAX_LOCAL_PERMISSION_SNAPSHOT_LENGTH = 64 * 1024;
const MAX_LOCAL_PERMISSION_REVIEW_LENGTH = 16 * 1024;
const NON_REVIEWABLE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const DISPLAY_AFFECTING_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

function isAuthenticatedVoiceTarget(session: ReturnType<typeof storage.getState>['sessions'][string]): boolean {
    return isMetadataAuthenticatedForEffects(session?.metadata)
        || isAgentStateAuthenticatedForEffects(session?.agentState);
}

function getReviewableToolName(value: unknown): string | null {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_VOICE_TOOL_ID_LENGTH
        || NON_REVIEWABLE_CHARACTERS.test(value)
    ) {
        return null;
    }
    return value;
}

function snapshotLocalPermissionRequest(value: unknown): string | null {
    try {
        const serialized = JSON.stringify(value);
        if (
            typeof serialized !== 'string'
            || serialized.length > MAX_LOCAL_PERMISSION_SNAPSHOT_LENGTH
        ) {
            return null;
        }
        return serialized;
    } catch {
        return null;
    }
}

function escapeDisplayAffectingCharacters(value: string): string {
    return value.replace(DISPLAY_AFFECTING_CHARACTERS, (character) => (
        `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
    ));
}

function buildLocalPermissionReview(
    sessionId: string,
    requestId: string,
    pending: unknown,
): { snapshot: string; message: string } | null {
    const toolName = getReviewableToolName(
        typeof pending === 'object' && pending !== null && 'tool' in pending
            ? pending.tool
            : undefined,
    );
    const snapshot = snapshotLocalPermissionRequest(pending);
    if (!toolName || !snapshot) {
        return null;
    }

    const message = [
        `Target session: ${escapeDisplayAffectingCharacters(JSON.stringify(sessionId))}`,
        `Request: ${escapeDisplayAffectingCharacters(JSON.stringify(requestId))}`,
        `Tool: ${escapeDisplayAffectingCharacters(JSON.stringify(toolName))}`,
        'Exact permission request:',
        escapeDisplayAffectingCharacters(snapshot),
    ].join('\n');

    return message.length <= MAX_LOCAL_PERMISSION_REVIEW_LENGTH
        ? { snapshot, message }
        : null;
}

/**
 * Static client tools for the realtime voice interface.
 * These tools allow the voice assistant to interact with Claude Code sessions.
 */
export const realtimeClientTools = {
    /**
     * Send a message to a specific Claude Code session
     */
    sendMessageToSession: async (parameters: unknown) => {
        const schema = z.object({
            sessionId: z.string().min(1).max(MAX_VOICE_TOOL_ID_LENGTH),
            message: z.string()
                .min(1)
                .max(MAX_VOICE_MESSAGE_LENGTH)
                .refine((value) => !NON_REVIEWABLE_CHARACTERS.test(value))
        });
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('Voice tool rejected invalid message parameters');
            return "error (invalid parameters)";
        }

        const { sessionId, message } = parsed.data;
        const session = storage.getState().sessions[sessionId];
        if (!isAuthenticatedVoiceTarget(session)) {
            return 'error (session is not authenticated)';
        }

        const confirmed = await Modal.confirm(
            t('settingsVoice.messageConfirmTitle'),
            message,
            {
                cancelText: t('common.cancel'),
                confirmText: t('common.yes'),
            },
        );
        if (!confirmed) {
            return 'cancelled (local confirmation was not granted)';
        }

        // Provider-originated context is untrusted. Re-read and re-authenticate
        // the exact target after the user interaction so stale provider state
        // cannot outlive a local session revocation.
        const currentSession = storage.getState().sessions[sessionId];
        if (!isAuthenticatedVoiceTarget(currentSession)) {
            return 'error (session is no longer authenticated)';
        }
        await sync.sendMessage(sessionId, message, { source: 'voice' });
        incrementVoiceMessageCount();
        const voiceMessageCount = getVoiceMessageCount();
        if (isVoiceSessionStarted()) {
            getVoiceSession()?.sendContextualUpdate([
                '# Runtime counters updated',
                `- voice_message_count: ${voiceMessageCount}`,
            ].join('\n'));
        }
        return "sent [DO NOT say anything else, simply say 'sent']";
    },

    /**
     * Respond to a permission request from a Claude Code session
     */
    processPermissionRequest: async (parameters: unknown) => {
        const schema = z.object({
            sessionId: z.string().min(1).max(MAX_VOICE_TOOL_ID_LENGTH),
            requestId: z.string().min(1).max(MAX_VOICE_TOOL_ID_LENGTH),
            decision: z.enum(['allow', 'deny'])
        }).strict();
        const parsed = schema.safeParse(parameters);

        if (!parsed.success) {
            console.error('Voice tool rejected invalid permission parameters');
            return "error (invalid parameters)";
        }

        const { sessionId, requestId, decision } = parsed.data;

        // Bind provider routing to one exact authenticated session/request pair.
        const session = storage.getState().sessions[sessionId];
        const pendingRequest = isAgentStateAuthenticatedForEffects(session?.agentState)
            ? session.agentState?.requests?.[requestId]
            : null;

        if (!pendingRequest) {
            console.error('Voice tool could not find the permission request');
            return "error (permission request not found)";
        }

        const permissionReview = buildLocalPermissionReview(
            sessionId,
            requestId,
            pendingRequest,
        );

        try {
            if (decision === 'allow') {
                if (!permissionReview) {
                    return "error (permission request is not reviewable)";
                }
                const confirmed = await Modal.confirm(
                    t('settingsVoice.permissionConfirmTitle'),
                    permissionReview.message,
                    {
                        cancelText: t('common.cancel'),
                        confirmText: t('common.yes'),
                        destructive: true,
                    },
                );
                if (!confirmed) {
                    return "cancelled (local confirmation was not granted)";
                }
                const currentAgentState = storage.getState().sessions[sessionId]?.agentState;
                const pending = isAgentStateAuthenticatedForEffects(currentAgentState)
                    ? currentAgentState?.requests?.[requestId]
                    : null;
                if (!pending) {
                    return "error (permission request is no longer pending)";
                }
                if (
                    snapshotLocalPermissionRequest(pending) !== permissionReview.snapshot
                ) {
                    return "error (permission request changed during confirmation)";
                }
                await sessionAllow(sessionId, requestId);
                trackVoicePermissionResponse(true);
            } else {
                const currentAgentState = storage.getState().sessions[sessionId]?.agentState;
                const pending = isAgentStateAuthenticatedForEffects(currentAgentState)
                    ? currentAgentState?.requests?.[requestId]
                    : null;
                if (!pending) {
                    return "error (permission request is no longer pending)";
                }
                await sessionDeny(sessionId, requestId);
                trackVoicePermissionResponse(false);
            }
            return "done [DO NOT say anything else, simply say 'done']";
        } catch {
            console.error('Voice tool failed to process permission');
            return `error (failed to ${decision} permission)`;
        }
    }
};
