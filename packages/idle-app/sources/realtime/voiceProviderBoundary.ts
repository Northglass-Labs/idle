import type { VoiceSessionConfig } from './types';

export const MAX_VOICE_PROVIDER_ID_CHARS = 128;
export const MAX_VOICE_INITIAL_CONTEXT_CHARS = 32 * 1024;
export const MAX_VOICE_SYSTEM_PROMPT_CHARS = 16 * 1024;
export const MAX_VOICE_FIRST_MESSAGE_CHARS = 1024;
export const MAX_VOICE_PROVIDER_TEXT_CHARS = 32 * 1024;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function boundVoiceProviderText(
    value: string,
    maxChars = MAX_VOICE_PROVIDER_TEXT_CHARS,
): string {
    if (maxChars <= 0) return '';
    return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function requireVoiceProviderIdentifier(value: string): string {
    if (
        value.length === 0
        || value.length > MAX_VOICE_PROVIDER_ID_CHARS
        || value.trim() !== value
        || CONTROL_CHARACTERS.test(value)
    ) {
        throw new Error('Invalid voice session identifier');
    }
    return value;
}

export function buildVoiceProviderConversationFields(
    config: Pick<VoiceSessionConfig, 'sessionId' | 'initialContext' | 'systemPrompt' | 'firstMessage'>,
    language: string | undefined,
) {
    const systemPrompt = config.systemPrompt
        ? boundVoiceProviderText(config.systemPrompt, MAX_VOICE_SYSTEM_PROMPT_CHARS)
        : undefined;
    const firstMessage = config.firstMessage
        ? boundVoiceProviderText(config.firstMessage, MAX_VOICE_FIRST_MESSAGE_CHARS)
        : undefined;

    return {
        dynamicVariables: {
            sessionId: requireVoiceProviderIdentifier(config.sessionId),
            initialConversationContext: boundVoiceProviderText(
                config.initialContext ?? '',
                MAX_VOICE_INITIAL_CONTEXT_CHARS,
            ),
        },
        overrides: {
            agent: {
                ...(systemPrompt ? { prompt: { prompt: systemPrompt } } : {}),
                ...(firstMessage ? { firstMessage } : {}),
                language,
            },
        },
    };
}
