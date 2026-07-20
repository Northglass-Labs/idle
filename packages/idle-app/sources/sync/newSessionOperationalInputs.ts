import type { Session } from './storageTypes';
import { getOperationalSessionMetadata } from './sessionOperationalState';

type Worktree = { path: string; branch: string };

export function getOperationalRecentPaths(
    sessions: readonly (Session | string)[],
    machineId: string,
): string[] {
    const paths = new Set<string>();
    for (const entry of sessions) {
        if (typeof entry === 'string') continue;
        const metadata = getOperationalSessionMetadata(entry.metadata);
        if (metadata?.machineId === machineId && metadata.path) {
            paths.add(metadata.path);
        }
    }
    return [...paths].sort();
}

export async function loadNewSessionWorktrees(
    selection: {
        machineId: string | null;
        resolvedPath: string | null;
        machineOnline: boolean;
    },
    listWorktrees: (machineId: string, path: string) => Promise<Worktree[]>,
): Promise<Worktree[]> {
    if (
        !selection.machineId
        || !selection.resolvedPath
        || !selection.machineOnline
    ) {
        return [];
    }
    return listWorktrees(selection.machineId, selection.resolvedPath);
}
