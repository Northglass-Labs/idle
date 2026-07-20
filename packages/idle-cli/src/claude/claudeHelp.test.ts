import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeHelp } from './claudeHelp';

describe('readClaudeHelp', () => {
    it('runs the non-executable CommonJS launcher through the active Node runtime', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'idle-claude-help-'));
        const launcherPath = path.join(directory, 'launcher.cjs');

        try {
            writeFileSync(
                launcherPath,
                "process.stdout.write(process.argv[2] === '--help' ? 'CLAUDE HELP' : 'unexpected');\n",
                { mode: 0o600 },
            );

            expect(readClaudeHelp(launcherPath)).toBe('CLAUDE HELP');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
