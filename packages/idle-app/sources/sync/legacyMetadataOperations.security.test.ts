import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const metadata = {
        machineId: 'relay-machine',
        path: '/relay-selected/project.idle-worktrees/task',
    };
    const session = {
        id: 'legacy-session',
        active: true,
        metadata,
    };
    const storageModule = {
        getOperationalSessionMetadata: (value: unknown) => (
            mocks.metadataTrusted ? value : null
        ),
        isMetadataAuthenticatedForEffects: () => mocks.metadataTrusted,
        storage: {
            getState: () => ({
                sessions: { 'legacy-session': session },
                getActiveSessions: () => [session],
                applyGitStatus: mocks.applyGitStatus,
            }),
        },
    };
    return {
        metadata,
        session,
        storageModule,
        metadataTrusted: false,
        sessionBash: vi.fn(),
        machineBash: vi.fn(),
        removeWorktree: vi.fn(),
        confirm: vi.fn(),
        applyGitStatus: vi.fn(),
    };
});

vi.mock('./storage', () => mocks.storageModule);
vi.mock('@/sync/storage', () => mocks.storageModule);
vi.mock('./ops', () => ({
    sessionBash: mocks.sessionBash,
    machineBash: mocks.machineBash,
}));
vi.mock('@/sync/ops', () => ({
    sessionBash: mocks.sessionBash,
    machineBash: mocks.machineBash,
}));
vi.mock('@/utils/worktree', () => ({
    isWorktreePath: () => true,
    removeWorktree: mocks.removeWorktree,
}));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { getGitStatusFiles } from './gitStatusFiles';
import { getProjectFiles } from './projectFiles';
import { GitStatusSync } from './gitStatusSync';

describe('legacy metadata operation boundaries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.metadataTrusted = false;
        mocks.sessionBash.mockResolvedValue({
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        mocks.machineBash.mockResolvedValue({ success: true, stdout: '' });
        mocks.confirm.mockResolvedValue(true);
    });

    it('does not run Git status or project-file RPCs at a display-only legacy cwd', async () => {
        await expect(getGitStatusFiles('legacy-session')).resolves.toBeNull();
        await expect(getProjectFiles('legacy-session')).resolves.toBeNull();

        expect(mocks.sessionBash).not.toHaveBeenCalled();
    });

    it('does not inspect or remove a worktree selected by display-only legacy metadata', async () => {
        await maybeCleanupWorktree(
            'legacy-session',
            mocks.metadata.path,
            mocks.metadata.machineId,
        );

        expect(mocks.machineBash).not.toHaveBeenCalled();
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.removeWorktree).not.toHaveBeenCalled();
    });

    it('revalidates metadata provenance after a Git sync has already been registered', async () => {
        mocks.metadataTrusted = true;
        const gitStatusSync = new GitStatusSync();
        gitStatusSync.getSync('legacy-session');
        mocks.sessionBash.mockClear();

        mocks.metadataTrusted = false;
        await (gitStatusSync as any).fetchGitStatusForProject(
            'legacy-session',
            `${mocks.metadata.machineId}:${mocks.metadata.path}`,
        );

        expect(mocks.sessionBash).not.toHaveBeenCalled();
    });

    it('keeps authenticated Git status RPCs pinned to the captured trusted path', async () => {
        mocks.metadataTrusted = true;
        const gitStatusSync = new GitStatusSync();

        await (gitStatusSync as any).fetchGitStatusForProject(
            'legacy-session',
            `${mocks.metadata.machineId}:${mocks.metadata.path}`,
        );

        expect(mocks.sessionBash).toHaveBeenCalledTimes(4);
        expect(mocks.sessionBash.mock.calls.every(([, request]) => (
            request.cwd === mocks.metadata.path
        ))).toBe(true);
    });
});
