export const MAX_VOICE_PROMPT_CHARS = 4 * 1024;
export const MAX_VOICE_CONTEXT_CHARS = 32 * 1024;
export const MAX_PENDING_VOICE_PROMPTS = 16;
export const MAX_PENDING_VOICE_PROMPT_CHARS = 32 * 1024;

export function boundVoiceText(value: string, maxChars = MAX_VOICE_PROMPT_CHARS): string {
    return value.length <= maxChars ? value : value.slice(0, maxChars);
}

export class BoundedVoicePromptQueue {
    private prompts: string[] = [];
    private chars = 0;

    get size(): number {
        return this.prompts.length;
    }

    get totalChars(): number {
        return this.chars;
    }

    enqueue(value: string): void {
        const prompt = boundVoiceText(value);
        if (!prompt) return;

        while (
            this.prompts.length >= MAX_PENDING_VOICE_PROMPTS
            || this.chars + prompt.length > MAX_PENDING_VOICE_PROMPT_CHARS
        ) {
            const removed = this.prompts.shift();
            if (removed === undefined) break;
            this.chars -= removed.length;
        }

        this.prompts.push(prompt);
        this.chars += prompt.length;
    }

    drain(): string[] {
        const values = this.prompts;
        this.prompts = [];
        this.chars = 0;
        return values;
    }

    clear(): void {
        this.prompts = [];
        this.chars = 0;
    }
}
