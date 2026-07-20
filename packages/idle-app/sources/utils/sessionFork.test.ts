import { beforeEach, describe, expect, it, vi } from 'vitest';

const trust = vi.hoisted(() => ({ metadata: true }));

vi.mock('@/sync/storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => trust.metadata ? value : null,
}));

import { getSessionForkSource } from './sessionFork';

describe('getSessionForkSource', () => {
    beforeEach(() => {
        trust.metadata = true;
    });

    it('returns a Claude fork source when the session has a Claude session id', () => {
        expect(getSessionForkSource({
            id: 'idle-claude',
            metadata: {
                flavor: 'claude',
                machineId: 'machine-1',
                path: '/tmp/project',
                claudeSessionId: '11111111-1111-4111-8111-111111111111',
            },
        } as any)).toEqual({
            kind: 'claude',
            sessionId: 'idle-claude',
            machineId: 'machine-1',
            directory: '/tmp/project',
            claudeSessionId: '11111111-1111-4111-8111-111111111111',
        });
    });

    it('returns a Codex fork source when the session has a Codex thread id', () => {
        expect(getSessionForkSource({
            id: 'idle-codex',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
            },
        } as any)).toEqual({
            kind: 'codex',
            sessionId: 'idle-codex',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        });
    });

    it('returns null when required fork metadata is missing', () => {
        expect(getSessionForkSource({
            id: 'missing',
            metadata: {
                flavor: 'codex',
                machineId: 'machine-1',
                path: '/tmp/project',
            },
        } as any)).toBeNull();
    });

    it('returns null when source coordinates are display-only legacy metadata', () => {
        trust.metadata = false;

        expect(getSessionForkSource({
            id: 'session-legacy',
            metadata: {
                machineId: 'machine-1',
                path: '/repo',
                flavor: 'codex',
                codexThreadId: 'thread-legacy',
            },
        } as any)).toBeNull();
    });
});
