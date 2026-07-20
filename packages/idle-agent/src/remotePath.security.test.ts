import { describe, expect, it, vi } from 'vitest';
import { resolveRemotePath } from './remotePath';

describe('remote spawn directory authority', () => {
    it.each([undefined, '~'])(
        'uses a freshly authenticated daemon home for %s instead of cached metadata',
        async (rawPath) => {
            const loadMachineHome = vi.fn().mockResolvedValue('/live-machine-home');

            await expect(resolveRemotePath(rawPath, loadMachineHome))
                .resolves.toBe('/live-machine-home');
            expect(loadMachineHome).toHaveBeenCalledOnce();
        },
    );

    it('resolves a home-relative path from the freshly authenticated daemon value', async () => {
        const loadMachineHome = vi.fn().mockResolvedValue('C:\\Users\\live-user');

        await expect(resolveRemotePath('~/project', loadMachineHome))
            .resolves.toBe('C:\\Users\\live-user\\project');
        expect(loadMachineHome).toHaveBeenCalledOnce();
    });

    it('keeps an explicit absolute path independent of machine metadata and home RPCs', async () => {
        const loadMachineHome = vi.fn().mockRejectedValue(new Error('must not be called'));

        await expect(resolveRemotePath('/explicit/workspace', loadMachineHome))
            .resolves.toBe('/explicit/workspace');
        expect(loadMachineHome).not.toHaveBeenCalled();
    });

    it.each(['relative/workspace', '', 'bad\0path'])(
        'rejects invalid explicit remote path %j before spawning',
        async (rawPath) => {
            const loadMachineHome = vi.fn();

            await expect(resolveRemotePath(rawPath, loadMachineHome))
                .rejects.toThrow('absolute remote path');
            expect(loadMachineHome).not.toHaveBeenCalled();
        },
    );
});
