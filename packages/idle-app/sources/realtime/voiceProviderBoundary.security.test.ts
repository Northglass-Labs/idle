import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    MAX_VOICE_FIRST_MESSAGE_CHARS,
    MAX_VOICE_INITIAL_CONTEXT_CHARS,
    MAX_VOICE_PROVIDER_ID_CHARS,
    MAX_VOICE_PROVIDER_TEXT_CHARS,
    MAX_VOICE_SYSTEM_PROMPT_CHARS,
    boundVoiceProviderText,
    buildVoiceProviderConversationFields,
} from './voiceProviderBoundary';

describe('final ElevenLabs payload boundary', () => {
    it('bounds every app-controlled conversation field before SDK handoff', () => {
        const fields = buildVoiceProviderConversationFields({
            sessionId: 'session-opaque-id',
            initialContext: 'c'.repeat(MAX_VOICE_INITIAL_CONTEXT_CHARS + 100),
            systemPrompt: 's'.repeat(MAX_VOICE_SYSTEM_PROMPT_CHARS + 100),
            firstMessage: 'f'.repeat(MAX_VOICE_FIRST_MESSAGE_CHARS + 100),
        }, 'en');

        expect(fields.dynamicVariables.sessionId.length).toBeLessThanOrEqual(MAX_VOICE_PROVIDER_ID_CHARS);
        expect(fields.dynamicVariables.initialConversationContext.length)
            .toBeLessThanOrEqual(MAX_VOICE_INITIAL_CONTEXT_CHARS);
        expect(fields.overrides.agent.prompt?.prompt.length)
            .toBeLessThanOrEqual(MAX_VOICE_SYSTEM_PROMPT_CHARS);
        expect(fields.overrides.agent.firstMessage?.length)
            .toBeLessThanOrEqual(MAX_VOICE_FIRST_MESSAGE_CHARS);
        expect(boundVoiceProviderText('x'.repeat(MAX_VOICE_PROVIDER_TEXT_CHARS + 100)).length)
            .toBeLessThanOrEqual(MAX_VOICE_PROVIDER_TEXT_CHARS);
    });

    it('rejects invalid opaque session identifiers instead of truncating a routing identity', () => {
        expect(() => buildVoiceProviderConversationFields({
            sessionId: 's'.repeat(MAX_VOICE_PROVIDER_ID_CHARS + 1),
        }, 'en')).toThrow('Invalid voice session identifier');
    });

    it('routes both native and web SDK calls through the shared final boundary', () => {
        const realtimeDir = __dirname;
        for (const file of ['RealtimeVoiceSession.tsx', 'RealtimeVoiceSession.web.tsx']) {
            const source = fs.readFileSync(path.join(realtimeDir, file), 'utf8');
            expect(source).toContain('buildVoiceProviderConversationFields');
            expect(source).toContain('boundVoiceProviderText');
            expect(source).not.toContain('sendUserMessage(message)');
            expect(source).not.toContain('sendContextualUpdate(update)');
        }
    });
});
