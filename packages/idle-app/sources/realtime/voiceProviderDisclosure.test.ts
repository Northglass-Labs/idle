import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { en as defaultCopy } from '@/text/_default';
import { ca } from '@/text/translations/ca';
import { en } from '@/text/translations/en';
import { es } from '@/text/translations/es';
import { it as itCopy } from '@/text/translations/it';
import { ja } from '@/text/translations/ja';
import { pl } from '@/text/translations/pl';
import { pt } from '@/text/translations/pt';
import { ru } from '@/text/translations/ru';
import { zhHans } from '@/text/translations/zh-Hans';
import { zhHant } from '@/text/translations/zh-Hant';

const localeCopies = [defaultCopy, en, ca, es, itCopy, ja, pl, pt, ru, zhHans, zhHant];

describe('voice provider public disclosure', () => {
    it('names ElevenLabs and the multi-session context boundary in every locale', () => {
        for (const copy of localeCopies) {
            expect(copy.settings.voiceAssistantInfo).toContain('ElevenLabs');
            expect(copy.settings.voiceAssistantInfo.length).toBeGreaterThan(100);
        }

        expect(defaultCopy.settings.voiceAssistantInfo).toContain('active-session titles and summaries');
        expect(defaultCopy.settings.voiceAssistantInfo).toContain('transcript updates');
        expect(defaultCopy.settings.voiceAssistantInfo).toContain('opaque session/request IDs');
        expect(defaultCopy.settings.voiceAssistantInfo).toContain('permission tool names');
        expect(defaultCopy.settings.voiceAssistantInfo).toContain('does not separately add stored project paths or permission arguments');
        expect(defaultCopy.settings.voiceAssistantInfo).toContain('Transcript text can itself contain sensitive data');
    });

    it('documents the actual direct-agent client tool name in every locale', () => {
        for (const copy of localeCopies) {
            expect(copy.settingsVoice.byoDescription).toContain('sendMessageToSession');
            expect(copy.settingsVoice.promptGuideDescription).toContain('sendMessageToSession');
            expect(copy.settingsVoice.byoDescription).not.toContain('messageClaudeCode');
            expect(copy.settingsVoice.promptGuideDescription).not.toContain('messageClaudeCode');
        }
    });

    it('keeps the repository privacy and security summaries aligned with runtime behavior', () => {
        const root = path.resolve(__dirname, '../../../..');
        const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
        const security = fs.readFileSync(path.join(root, 'docs/SECURITY.md'), 'utf8');
        const selfHosting = fs.readFileSync(path.join(root, 'docs/SELF-HOSTING.md'), 'utf8');

        for (const document of [privacy, security, selfHosting]) {
            const normalized = document.replace(/\s+/g, ' ');
            expect(normalized).toContain('ElevenLabs');
            expect(normalized).toMatch(/titles and summaries/i);
            expect(normalized).toMatch(/transcript updates/i);
            expect(normalized).toMatch(/opaque session and request identifiers/i);
            expect(normalized).toMatch(/permission tool names/i);
            expect(normalized).toMatch(/does not separately (?:add|forward) stored project paths or permission arguments/i);
            expect(normalized).toMatch(/transcript text can itself contain sensitive data/i);
        }
    });
});
