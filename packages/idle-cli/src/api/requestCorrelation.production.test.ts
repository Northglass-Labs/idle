import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('remote request correlation production wiring', () => {
    it.each([
        ['Codex', '../codex/runCodex.ts'],
        ['Gemini', '../gemini/runGemini.ts'],
        ['generic ACP', '../agent/acp/runAcp.ts'],
        ['OpenClaw', '../openclaw/runOpenClaw.ts'],
    ])('%s captures, activates, and clears the authenticated request ID', async (_provider, path) => {
        const implementation = await source(path);

        expect(implementation).toContain('message.messageIdentity?.messageId');
        expect(implementation).toContain('setActiveRequestId(');
        expect(implementation).toContain('setActiveRequestId(null)');
    });

    it('Claude carries the authenticated ID through its queue and remote SDK lifecycle', async () => {
        const orchestration = await source('../claude/runClaude.ts');
        const launcher = await source('../claude/claudeRemoteLauncher.ts');

        expect(orchestration).toContain('message.messageIdentity?.messageId');
        expect(orchestration).toContain('requestId: mode.requestId');
        expect(launcher).toContain('setActiveRequestId(mode.requestId ?? null)');
        expect(launcher).toContain('setActiveRequestId(null)');
    });
});
