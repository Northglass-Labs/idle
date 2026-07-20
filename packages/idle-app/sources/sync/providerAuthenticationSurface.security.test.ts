import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
    return readFileSync(new URL(file, import.meta.url), 'utf8');
}

describe('coding-agent authentication surface', () => {
    it('does not ship relay-held provider-token controls or routes', () => {
        expect(existsSync(new URL('../app/(app)/settings/connect/claude.tsx', import.meta.url))).toBe(false);
        expect(existsSync(new URL('./apiServices.ts', import.meta.url))).toBe(false);
        expect(existsSync(new URL('../hooks/useElevenLabsKeyStatus.ts', import.meta.url))).toBe(false);

        const settings = source('../components/IdleSettingsView.tsx');
        const account = source('../app/(app)/settings/account.tsx');
        const layout = source('../app/(app)/_layout.tsx');
        const profile = source('./profile.ts');
        const operations = source('./ops.ts');
        const persistedSettings = source('./settings.ts');

        for (const implementation of [settings, account, layout, profile]) {
            expect(implementation).not.toMatch(/connectedServices|disconnectService|connect\/claude|anthropic/i);
        }
        expect(operations).not.toMatch(/\btoken\?:\s*string/);
        expect(operations).not.toMatch(/approvedNewDirectoryCreation\s*=\s*false,\s*token\b/);
        expect(operations).not.toMatch(/approvedNewDirectoryCreation,\s*token\b/);
        expect(persistedSettings).not.toMatch(/inferenceOpenAIKey\s*:|OpenAI API key for inference/i);
    });

    it('explains the local official-CLI credential boundary', () => {
        const translations = source('../text/_default.ts');

        expect(translations).toMatch(/Claude Code, Codex, and Gemini/i);
        expect(translations).toMatch(/official CLIs/i);
        expect(translations).toMatch(/paired (?:computer|machine)/i);
        expect(translations).toMatch(/Idle (?:does not|never) stores? (?:those )?provider credentials/i);
    });
});
