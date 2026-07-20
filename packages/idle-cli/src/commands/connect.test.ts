import { describe, expect, it, vi } from 'vitest';
import { handleConnectCommand } from './connect';

describe('idle connect gemini', () => {
    it('keeps official Gemini credentials local instead of harvesting or uploading OAuth tokens', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await handleConnectCommand(['gemini']);
            const output = log.mock.calls.flat().join('\n');
            expect(output).toContain('official Gemini CLI');
            expect(output).toContain('GEMINI_API_KEY');
            expect(output).toContain('never uploaded');
        } finally {
            log.mockRestore();
        }
    });

    it('documents a local-only provider credential boundary', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await handleConnectCommand(['help']);
            const output = log.mock.calls.flat().join('\n');
            expect(output).toContain('provider credentials stay local');
            expect(output).toContain('idle connect gemini');
            expect(output).not.toContain('idle connect codex');
            expect(output).not.toContain('idle connect claude');
            expect(output).not.toContain('idle connect status');
            expect(output).not.toContain('Idle cloud');
        } finally {
            log.mockRestore();
        }
    });
});
