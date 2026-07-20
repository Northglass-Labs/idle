import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';

import { ApiMachineClient } from './apiMachine';

const VALID_CLAUDE_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function spawnHandlerFrom(client: ApiMachineClient): (params: unknown) => Promise<unknown> {
    const handlers = (client as any).rpcHandlerManager.handlers as Map<string, (params: unknown) => Promise<unknown>>;
    const handler = handlers.get('machine-1:spawn-idle-session');
    if (!handler) {
        throw new Error('spawn-idle-session handler was not registered');
    }
    return handler;
}

function machineHomeHandlerFrom(client: ApiMachineClient): (params: unknown) => Promise<unknown> {
    const handlers = (client as any).rpcHandlerManager.handlers as Map<string, (params: unknown) => Promise<unknown>>;
    const handler = handlers.get('machine-1:machine-home-directory');
    if (!handler) {
        throw new Error('machine-home-directory handler was not registered');
    }
    return handler;
}

function clientWithSpawn(spawnSession: ReturnType<typeof vi.fn>) {
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        spawnSession,
        stopSession: vi.fn(),
        requestShutdown: vi.fn(),
    });
    return client;
}

describe('ApiMachineClient spawn RPC boundary', () => {
    it('returns the live daemon home rather than relay-supplied machine metadata', async () => {
        const client = new ApiMachineClient('token', {
            ...machineClient(),
            metadata: { homeDir: '/stale-relay-home' },
        });
        const handler = machineHomeHandlerFrom(client);

        await expect(handler({})).resolves.toEqual({ directory: homedir() });
        await expect(handler({ unexpected: true })).rejects.toThrow('Invalid machine home request');
    });

    it.each([
        ['relative directory', { directory: 'relative/project' }],
        ['unknown field', { directory: '/tmp/project', providerToken: 'must-not-forward' }],
        ['invalid agent', { directory: '/tmp/project', agent: 'shell' }],
        ['invalid boolean', { directory: '/tmp/project', commitAttribution: 'yes' }],
        ['invalid lineage ID', { directory: '/tmp/project', parentSessionId: 'parent\nforged' }],
        ['oversized thread ID', { directory: '/tmp/project', resumeCodexThreadId: 'x'.repeat(513) }],
        [
            'Codex resume coordinate for Claude',
            { directory: '/tmp/project', agent: 'claude', resumeCodexThreadId: 'thread-1' },
        ],
        [
            'Claude resume coordinate for Codex',
            { directory: '/tmp/project', agent: 'codex', resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID },
        ],
        [
            'two provider resume coordinates',
            {
                directory: '/tmp/project',
                agent: 'codex',
                resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID,
                resumeCodexThreadId: 'thread-1',
            },
        ],
        ['fork message without a parent session', { directory: '/tmp/project', forkedFromMessageId: 'message-1' }],
        ['invalid environment key', { directory: '/tmp/project', environmentVariables: { 'BAD-NAME': 'value' } }],
        ['NUL environment value', { directory: '/tmp/project', environmentVariables: { SAFE_NAME: 'a\0b' } }],
        [
            'oversized environment value',
            { directory: '/tmp/project', environmentVariables: { SAFE_NAME: 'x'.repeat(32 * 1024 + 1) } },
        ],
        [
            'multibyte environment value beyond the byte limit',
            { directory: '/tmp/project', environmentVariables: { SAFE_NAME: '🧊'.repeat(8 * 1024 + 1) } },
        ],
        [
            'too many environment entries',
            {
                directory: '/tmp/project',
                environmentVariables: Object.fromEntries(
                    Array.from({ length: 129 }, (_, index) => [`SAFE_${index}`, 'value']),
                ),
            },
        ],
        [
            'oversized aggregate environment',
            {
                directory: '/tmp/project',
                environmentVariables: Object.fromEntries(
                    Array.from({ length: 9 }, (_, index) => [`SAFE_${index}`, 'x'.repeat(32 * 1024)]),
                ),
            },
        ],
    ])('rejects a %s before spawning', async (_label, params) => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'must-not-spawn' });
        const handler = spawnHandlerFrom(clientWithSpawn(spawnSession));

        await expect(handler(params)).rejects.toThrow('Invalid spawn session request');
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('accepts the supported app payload and defaults directory creation to denied', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'idle-new' });
        const handler = spawnHandlerFrom(clientWithSpawn(spawnSession));
        const environmentVariables = Object.fromEntries(
            Array.from({ length: 128 }, (_, index) => [`SAFE_${index}`, `value-${index}`]),
        );

        await expect(handler({
            type: 'spawn-in-directory',
            directory: '/tmp/project',
            agent: 'claude',
            commitAttribution: false,
            environmentVariables,
            resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID,
            parentSessionId: 'idle-parent_1',
            forkedFromMessageId: 'message-1',
        })).resolves.toEqual({ type: 'success', sessionId: 'idle-new' });

        expect(spawnSession).toHaveBeenCalledWith({
            directory: '/tmp/project',
            approvedNewDirectoryCreation: false,
            agent: 'claude',
            commitAttribution: false,
            environmentVariables,
            resumeClaudeSessionId: VALID_CLAUDE_SESSION_ID,
            parentSessionId: 'idle-parent_1',
            forkedFromMessageId: 'message-1',
        });
    });

    it('preserves explicit directory-creation approval', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'idle-new' });
        const handler = spawnHandlerFrom(clientWithSpawn(spawnSession));

        await handler({
            directory: '/tmp/project',
            approvedNewDirectoryCreation: true,
        });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            approvedNewDirectoryCreation: true,
        }));
    });
});
