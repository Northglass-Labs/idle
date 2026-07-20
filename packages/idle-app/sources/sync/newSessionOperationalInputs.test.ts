import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getOperationalRecentPaths,
    loadNewSessionWorktrees,
} from './newSessionOperationalInputs';
import { markMetadataAuthenticatedForEffects } from './sessionOperationalState';

function session(id: string, machineId: string, path: string) {
    return {
        id,
        metadata: { machineId, path, host: 'host' },
    } as any;
}

describe('new-session operational path boundary', () => {
    const listWorktrees = vi.fn();

    beforeEach(() => {
        listWorktrees.mockReset();
        listWorktrees.mockResolvedValue([{ path: '/trusted/worktree', branch: 'task' }]);
    });

    it('does not turn a display-only legacy path into a listWorktrees RPC', async () => {
        const legacy = session('legacy', 'machine-a', '/relay-selected/project');
        const paths = getOperationalRecentPaths([legacy], 'machine-a');

        await expect(loadNewSessionWorktrees({
            machineId: 'machine-a',
            resolvedPath: paths[0] ?? null,
            machineOnline: true,
        }, listWorktrees)).resolves.toEqual([]);

        expect(paths).toEqual([]);
        expect(listWorktrees).not.toHaveBeenCalled();
    });

    it('keeps authenticated history and explicit user paths functional', async () => {
        const bound = session('bound', 'machine-a', '/trusted/project');
        markMetadataAuthenticatedForEffects(bound.metadata);

        expect(getOperationalRecentPaths([bound], 'machine-a'))
            .toEqual(['/trusted/project']);
        await expect(loadNewSessionWorktrees({
            machineId: 'machine-a',
            resolvedPath: '/trusted/project',
            machineOnline: true,
        }, listWorktrees)).resolves.toEqual([
            { path: '/trusted/worktree', branch: 'task' },
        ]);
        expect(listWorktrees).toHaveBeenCalledWith('machine-a', '/trusted/project');
    });
});
