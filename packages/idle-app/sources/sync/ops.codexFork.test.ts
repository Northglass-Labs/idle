import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions },
}));

vi.mock('./storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => value,
    getOperationalAgentState: (value: unknown) => value,
    storage: {
        getState: () => ({
            sessions: {
                'idle-source': {
                    id: 'idle-source',
                    metadata: {
                        flavor: 'codex',
                        machineId: 'machine-1',
                        path: '/tmp/project',
                        codexThreadId: 'thread-source',
                    },
                },
            },
        }),
    },
}));

// storage -> knownTools -> @/text pulls expo-localization, whose native module
// cannot initialize in node-mode vitest. The fork ops only need key passthrough.
vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

// knownTools imports the vector-icon set (native assets); storage only calls
// isMutableTool from it.
vi.mock('@/components/tools/knownTools', () => ({
    isMutableTool: () => false,
}));

// react-native-mmkv's ESM dist value-imports react-native (Flow syntax), which
// node-mode vitest cannot parse. Persistence only needs a tiny in-memory KV here.
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        private store = new Map<string, unknown>();
        getString(k: string) { const v = this.store.get(k); return typeof v === 'string' ? v : undefined; }
        getNumber(k: string) { const v = this.store.get(k); return typeof v === 'number' ? v : undefined; }
        getBoolean(k: string) { const v = this.store.get(k); return typeof v === 'boolean' ? v : undefined; }
        set(k: string, v: unknown) { this.store.set(k, v); }
        delete(k: string) { this.store.delete(k); }
        clearAll() { this.store.clear(); }
    },
}));

// Cut the realtime/voice subtree: storage.ts only needs these two accessors, and
// the real module now reaches react-native (Flow) via voiceExperiment -> @/track
// -> posthog-react-native, which node-mode vitest cannot parse.
vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => null,
    getVoiceSession: () => null,
}));

describe('codex fork ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('forks a full Codex thread and spawns a Codex session resumed to the new thread', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-forked' };
            }
            if (method === 'spawn-idle-session') {
                return { type: 'success', sessionId: 'idle-forked' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'idle-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'idle-forked' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-fork-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-idle-session',
            expect.objectContaining({
                agent: 'codex',
                directory: '/tmp/project',
                resumeCodexThreadId: 'thread-forked',
                parentSessionId: 'idle-source',
            }),
        );
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('duplicates a Codex thread from a selected user item before spawning', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-duplicate-thread') {
                return { type: 'success', newCodexThreadId: 'thread-cut' };
            }
            if (method === 'spawn-idle-session') {
                return { type: 'success', sessionId: 'idle-cut' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'idle-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        }, {
            cutAfterItemId: 'user-item-2',
            forkedFromMessageId: 'message-2',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'idle-cut' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-duplicate-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source', cutAfterItemId: 'user-item-2' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-idle-session',
            expect.objectContaining({
                agent: 'codex',
                resumeCodexThreadId: 'thread-cut',
                forkedFromMessageId: 'message-2',
            }),
        );
    });

    it('does not spawn from a malformed decrypted fork response', async () => {
        machineRPC.mockResolvedValue({
            type: 'success',
            newCodexThreadId: 'thread-forked',
            attacker: true,
        });

        const { forkAndSpawn } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'idle-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'error', errorMessage: 'Invalid remote control response' });
        expect(machineRPC).toHaveBeenCalledTimes(1);
        expect(refreshSessions).not.toHaveBeenCalled();
    });
});
