import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const metadata = {
        flavor: 'codex',
        machineId: 'relay-machine',
        path: '/relay-selected/project',
        codexThreadId: 'relay-thread',
    };
    const agentState = {
        requests: {
            'relay-request': { tool: 'Bash', arguments: { command: 'open door' } },
        },
        agentGoalStatus: {
            status: 'active',
            source: 'codex',
            sourceSessionId: 'relay-thread',
            text: 'relay goal',
            observedAt: 1,
        },
    };
    return {
        metadata,
        agentState,
        metadataTrusted: false,
        agentStateTrusted: false,
        machineRPC: vi.fn(),
        sessionRPC: vi.fn(),
        refreshSessions: vi.fn(),
    };
});

vi.mock('./apiSocket', () => ({
    apiSocket: {
        machineRPC: mocks.machineRPC,
        sessionRPC: mocks.sessionRPC,
        request: vi.fn(),
    },
}));
vi.mock('./sync', () => ({ sync: { refreshSessions: mocks.refreshSessions } }));
vi.mock('./storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => (
        mocks.metadataTrusted ? value : null
    ),
    getOperationalAgentState: (value: unknown) => (
        mocks.agentStateTrusted ? value : null
    ),
    storage: {
        getState: () => ({
            sessions: {
                'legacy-session': {
                    id: 'legacy-session',
                    metadata: mocks.metadata,
                    agentState: mocks.agentState,
                },
            },
        }),
    },
}));

import {
    forkAndSpawn,
    machineResumeSession,
    sessionAllow,
    sessionDeny,
    sessionGoalAction,
} from './ops';

describe('operation legacy trust boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.metadataTrusted = false;
        mocks.agentStateTrusted = false;
        mocks.machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'forked-thread' };
            }
            return { type: 'success', sessionId: 'spawned-session' };
        });
    });

    it('blocks resume when its machine and provider coordinates are display-only legacy metadata', async () => {
        const result = await machineResumeSession({
            machineId: 'relay-machine',
            sessionId: 'legacy-session',
        });

        expect(result.type).toBe('error');
        expect(mocks.machineRPC).not.toHaveBeenCalled();
    });

    it('blocks fork and spawn when the source coordinates are display-only legacy metadata', async () => {
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'legacy-session',
            machineId: 'relay-machine',
            directory: '/relay-selected/project',
            codexThreadId: 'relay-thread',
        });

        expect(result.type).toBe('error');
        expect(mocks.machineRPC).not.toHaveBeenCalled();
        expect(mocks.refreshSessions).not.toHaveBeenCalled();
    });

    it('blocks goal control actions sourced from display-only legacy agent state', async () => {
        await expect(sessionGoalAction('legacy-session', 'stop')).rejects.toThrow(
            'authenticated',
        );

        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('blocks permission decisions sourced from display-only legacy agent state', async () => {
        await expect(sessionAllow('legacy-session', 'relay-request')).rejects.toThrow(
            'authenticated',
        );
        await expect(sessionDeny('legacy-session', 'relay-request')).rejects.toThrow(
            'authenticated',
        );

        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });
});
