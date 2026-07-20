import { describe, expect, it } from 'vitest';

import {
    BoundedVoicePromptQueue,
    MAX_PENDING_VOICE_PROMPT_CHARS,
    MAX_PENDING_VOICE_PROMPTS,
    MAX_VOICE_PROMPT_CHARS,
    boundVoiceText,
} from './voicePromptQueue';

describe('voice prompt resource boundary', () => {
    it('bounds each external voice payload', () => {
        expect(boundVoiceText('x'.repeat(MAX_VOICE_PROMPT_CHARS + 100)).length)
            .toBe(MAX_VOICE_PROMPT_CHARS);
    });

    it('keeps the newest prompts within count and aggregate budgets', () => {
        const queue = new BoundedVoicePromptQueue();
        for (let index = 0; index < 100; index += 1) {
            queue.enqueue(`${index}:` + 'x'.repeat(4_000));
        }

        expect(queue.size).toBeLessThanOrEqual(MAX_PENDING_VOICE_PROMPTS);
        expect(queue.totalChars).toBeLessThanOrEqual(MAX_PENDING_VOICE_PROMPT_CHARS);
        const drained = queue.drain();
        expect(drained.at(-1)).toContain('99:');
        expect(queue.size).toBe(0);
        expect(queue.totalChars).toBe(0);
    });
});
