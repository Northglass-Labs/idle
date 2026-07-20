import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('session clipboard privacy boundary', () => {
    it('does not expose raw decrypted metadata or aggregated logs to the OS clipboard', () => {
        expect(existsSync(new URL('./copySessionMetadataToClipboard.ts', import.meta.url))).toBe(false);

        for (const sourceUrl of [
            new URL('../hooks/useSessionQuickActions.ts', import.meta.url),
            new URL('../app/(app)/session/[id]/info.tsx', import.meta.url),
            new URL('../components/SessionActionsNativeMenu.ios.tsx', import.meta.url),
            new URL('../components/SessionActionsNativeMenu.android.tsx', import.meta.url),
        ]) {
            const source = readFileSync(sourceUrl, 'utf8');
            expect(source).not.toMatch(/copySessionMetadata|Client Logs|log\.getLogs\(\)/);
        }
    });
});
