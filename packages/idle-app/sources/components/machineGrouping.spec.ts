import { describe, it, expect } from 'vitest';

/**
 * Machine grouping logic tests.
 *
 * ActiveSessionsGroup.tsx groups sessions by project path, then by machineId.
 * The grouping is inline in a useMemo — these tests extract and verify
 * the core algorithm as a pure function so it can be validated without React.
 */

interface MinimalSession {
    id: string;
    metadata: {
        path: string;
        machineId?: string;
    } | null;
}

interface MachineGroup {
    machineId: string;
    sessions: MinimalSession[];
}

/**
 * Groups sessions by machineId (mirrors the inner logic of ActiveSessionsGroup).
 * Sessions without a machineId get grouped under 'unknown'.
 */
function groupSessionsByMachine(sessions: MinimalSession[]): Map<string, MachineGroup> {
    const groups = new Map<string, MachineGroup>();

    for (const session of sessions) {
        const machineId = session.metadata?.machineId || 'unknown';

        let group = groups.get(machineId);
        if (!group) {
            group = { machineId, sessions: [] };
            groups.set(machineId, group);
        }
        group.sessions.push(session);
    }

    return groups;
}

function makeSession(id: string, machineId?: string | null, path = '/project'): MinimalSession {
    return {
        id,
        metadata: {
            path,
            ...(machineId !== undefined && machineId !== null ? { machineId } : {}),
        },
    };
}

describe('Machine grouping', () => {

    describe('sessions group correctly by machineId', () => {
        it('groups two sessions on the same machine together', () => {
            const sessions = [
                makeSession('s1', 'machine-a'),
                makeSession('s2', 'machine-a'),
            ];
            const groups = groupSessionsByMachine(sessions);

            expect(groups.size).toBe(1);
            expect(groups.get('machine-a')!.sessions).toHaveLength(2);
        });

        it('separates sessions on different machines', () => {
            const sessions = [
                makeSession('s1', 'machine-a'),
                makeSession('s2', 'machine-b'),
            ];
            const groups = groupSessionsByMachine(sessions);

            expect(groups.size).toBe(2);
            expect(groups.get('machine-a')!.sessions).toHaveLength(1);
            expect(groups.get('machine-b')!.sessions).toHaveLength(1);
        });

        it('handles multiple machines with multiple sessions each', () => {
            const sessions = [
                makeSession('s1', 'machine-a'),
                makeSession('s2', 'machine-b'),
                makeSession('s3', 'machine-a'),
                makeSession('s4', 'machine-b'),
                makeSession('s5', 'machine-c'),
            ];
            const groups = groupSessionsByMachine(sessions);

            expect(groups.size).toBe(3);
            expect(groups.get('machine-a')!.sessions).toHaveLength(2);
            expect(groups.get('machine-b')!.sessions).toHaveLength(2);
            expect(groups.get('machine-c')!.sessions).toHaveLength(1);
        });
    });

    describe('null / missing machineId sessions form their own group', () => {
        it('groups sessions without machineId under "unknown"', () => {
            const sessions = [
                makeSession('s1'), // no machineId
                makeSession('s2'), // no machineId
            ];
            const groups = groupSessionsByMachine(sessions);

            expect(groups.size).toBe(1);
            expect(groups.has('unknown')).toBe(true);
            expect(groups.get('unknown')!.sessions).toHaveLength(2);
        });

        it('keeps unknown separate from named machines', () => {
            const sessions = [
                makeSession('s1', 'machine-a'),
                makeSession('s2'), // no machineId
            ];
            const groups = groupSessionsByMachine(sessions);

            expect(groups.size).toBe(2);
            expect(groups.get('machine-a')!.sessions).toHaveLength(1);
            expect(groups.get('unknown')!.sessions).toHaveLength(1);
        });

        it('handles null metadata by falling back to unknown', () => {
            const session: MinimalSession = { id: 's1', metadata: null };
            const groups = groupSessionsByMachine([session]);

            expect(groups.size).toBe(1);
            expect(groups.has('unknown')).toBe(true);
        });
    });

    describe('empty list returns empty groups', () => {
        it('returns an empty map for no sessions', () => {
            const groups = groupSessionsByMachine([]);
            expect(groups.size).toBe(0);
        });
    });
});
