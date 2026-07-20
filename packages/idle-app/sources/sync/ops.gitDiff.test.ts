import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sessionRPC } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

vi.mock('./storage', () => ({
    storage: { getState: () => ({}) },
}));

describe('bounded file RPCs', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
    });

    it('sends repository filenames as typed RPC data', async () => {
        sessionRPC.mockResolvedValue({ success: true, stdout: 'diff', stderr: '', exitCode: 0 });
        const { sessionGitDiff } = await import('./ops');
        const path = 'quote"$(touch${IFS}idle-injection-marker).txt';

        await expect(sessionGitDiff('session-1', { path, mode: 'head', timeout: 5_000, maxBytes: 1024 })).resolves.toEqual({
            success: true,
            stdout: 'diff',
            stderr: '',
            exitCode: 0,
        });
        expect(sessionRPC).toHaveBeenCalledWith('session-1', 'gitDiff', {
            path,
            mode: 'head',
            timeout: 5_000,
            maxBytes: 1024,
        });
    });

    it('returns the standard failure shape when the RPC rejects', async () => {
        sessionRPC.mockRejectedValue(new Error('offline'));
        const { sessionGitDiff } = await import('./ops');

        await expect(sessionGitDiff('session-1', { path: 'normal.ts', mode: 'working' })).resolves.toEqual({
            success: false,
            stdout: '',
            stderr: '',
            exitCode: -1,
            error: 'offline',
        });
    });

    it('rejects oversized diff and file responses before consumers decode or render them', async () => {
        const { sessionGitDiff, sessionReadFile, sessionRipgrep } = await import('./ops');

        sessionRPC.mockResolvedValueOnce({
            success: true,
            stdout: 'x'.repeat(257),
            stderr: '',
            exitCode: 0,
        });
        await expect(sessionGitDiff('session-1', {
            path: 'large.diff',
            mode: 'working',
            maxBytes: 256,
        })).resolves.toMatchObject({ success: false, error: expect.stringContaining('limit') });

        sessionRPC.mockResolvedValueOnce({
            success: true,
            stdout: '🙂'.repeat(65),
            stderr: '',
            exitCode: 0,
        });
        await expect(sessionRipgrep('session-1', ['--files'], undefined, 256)).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('limit'),
        });

        sessionRPC.mockResolvedValueOnce({
            success: true,
            content: Buffer.alloc(257, 0x61).toString('base64'),
        });
        await expect(sessionReadFile('session-1', 'large.txt', 256)).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('limit'),
        });
    });

    it('rejects malformed decrypted response shapes instead of trusting TypeScript casts', async () => {
        const { sessionGitDiff, sessionReadFile } = await import('./ops');

        sessionRPC.mockResolvedValueOnce({
            success: true,
            stdout: 'diff',
            stderr: '',
            exitCode: 0,
            attacker: true,
        });
        await expect(sessionGitDiff('session-1', { path: 'normal.ts', mode: 'working' }))
            .resolves.toMatchObject({ success: false, error: 'Invalid remote control response' });

        sessionRPC.mockResolvedValueOnce({ success: true, content: 'AB==' });
        await expect(sessionReadFile('session-1', 'normal.ts', 256))
            .resolves.toEqual({ success: false, error: 'Invalid remote control response' });
    });
});
