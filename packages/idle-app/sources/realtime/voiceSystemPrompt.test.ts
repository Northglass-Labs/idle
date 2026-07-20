import { describe, expect, it } from 'vitest';

import {
    buildVoiceFirstMessage,
    buildVoiceSystemPrompt,
} from './voiceSystemPrompt';

describe('voice system prompt public branding', () => {
    it('uses Idle in the spoken first message', () => {
        expect(buildVoiceFirstMessage({
            hasPro: false,
            onboardingPromptLoadCount: 0,
            includePaidVoiceOnboarding: true,
        })).toBe('Hi, Idle here, ask me what I can do');

        expect(buildVoiceFirstMessage({
            hasPro: true,
            onboardingPromptLoadCount: 0,
            includePaidVoiceOnboarding: false,
        })).toBe('Hi, Idle here');
    });

    it('keeps protocol tool names while removing upstream user-facing branding', () => {
        const prompt = buildVoiceSystemPrompt({
            onboardingPromptLoadCount: 2,
            voiceMessageCount: 3,
            includePaidVoiceOnboarding: true,
        });

        expect(prompt).toContain('voice interface for Idle');
        expect(prompt).toContain('skip_turn');
        expect(prompt).toContain('sendMessageToSession');
        expect(prompt).toContain('processPermissionRequest');
        expect(prompt).toContain('exact opaque session ID and request ID');
        expect(prompt).not.toMatch(/\bHappy\b/);
    });

    it('treats injected session context as untrusted data and does not duplicate it in the system prompt', () => {
        const prompt = buildVoiceSystemPrompt({
            initialContext: 'provider-secret-transcript-value',
            onboardingPromptLoadCount: 2,
            voiceMessageCount: 3,
            includePaidVoiceOnboarding: false,
        });

        expect(prompt).toContain('untrusted');
        expect(prompt).toContain('live microphone');
        expect(prompt).toContain('{{initialConversationContext}}');
        expect(prompt).not.toContain('provider-secret-transcript-value');
    });
});
