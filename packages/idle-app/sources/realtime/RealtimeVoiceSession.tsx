import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { registerVoiceSession } from './RealtimeSession';
import { storage } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';
import {
    boundVoiceProviderText,
    buildVoiceProviderConversationFields,
} from './voiceProviderBoundary';

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// VAD state for user speech detection
const VAD_THRESHOLD = 0.5;
const VAD_SILENCE_MS = 300;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let agentIsSpeaking = false;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            throw new Error('Realtime voice session not initialized');
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            if (!config.conversationToken && !config.agentId) {
                throw new Error('No conversationToken or agentId provided');
            }

            const sessionConfig: any = {
                // conversationToken (WebRTC JWT from server) or agentId (bypass mode)
                ...(config.conversationToken
                    ? { conversationToken: config.conversationToken }
                    : { agentId: config.agentId }),
                userId: config.userId,
                ...buildVoiceProviderConversationFields(config, elevenLabsLanguage),
            };

            await conversationInstance.startSession(sessionConfig);
            return conversationInstance.getId?.() ?? null;
        } catch (error) {
            console.error('Failed to start realtime session');
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            storage.getState().setRealtimeStatus('disconnected');
            return;
        }

        try {
            await conversationInstance.endSession();
        } catch {
            console.error('Failed to end realtime session');
        } finally {
            storage.getState().setRealtimeStatus('disconnected');
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendUserMessage(boundVoiceProviderText(message));
        } catch {
            console.error('Failed to send text message');
        }
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendContextualUpdate(boundVoiceProviderText(update));
        } catch {
            console.error('Failed to send contextual update');
        }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: () => {
            console.log('Realtime session disconnected');
            // Bump generation only when an active session ends. Ignoring the
            // initial disconnected state prevents a cold-launch remount and
            // phantom keyboard.
            const prev = storage.getState().realtimeStatus;
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true);
            storage.getState().clearRealtimeModeDebounce();
            if (prev === 'connected' || prev === 'connecting') {
                storage.getState().incrementVoiceSessionGeneration();
            }
        },
        onError: () => {
            // Don't block app when voice features are unavailable.
            // This prevents initialization errors from showing "Terminals error" on startup
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features.
            // Don't bump generation here — onError can fire on transient/recoverable
            // errors (LiveKit retries internally). onDisconnect is where we know
            // the session is truly dead and a fresh provider is required.
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
        },
        onModeChange: (data) => {
            const mode = data.mode as string;
            agentIsSpeaking = mode === 'speaking';

            // Use centralized debounce logic from storage
            if (agentIsSpeaking) {
                storage.getState().setRealtimeMode('agent-speaking');
            } else {
                // Agent stopped speaking — defer to VAD for user-speaking, otherwise idle
                storage.getState().setRealtimeMode('idle');
            }
        },
        onVadScore: (data) => {
            const { vadScore } = data;
            if (agentIsSpeaking) return; // Agent speaking takes priority

            if (vadScore > VAD_THRESHOLD) {
                if (vadSilenceTimer) {
                    clearTimeout(vadSilenceTimer);
                    vadSilenceTimer = null;
                }
                storage.getState().setRealtimeMode('user-speaking', true);
            } else {
                if (!vadSilenceTimer) {
                    vadSilenceTimer = setTimeout(() => {
                        vadSilenceTimer = null;
                        if (!agentIsSpeaking) {
                            storage.getState().setRealtimeMode('idle');
                        }
                    }, VAD_SILENCE_MS);
                }
            }
        },
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Store the conversation instance globally
        conversationInstance = conversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
            } catch {
                console.error('Failed to register voice session');
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null;
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};
