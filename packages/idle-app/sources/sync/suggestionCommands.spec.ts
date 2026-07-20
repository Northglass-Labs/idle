import { describe, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';

const mockSessions: Record<string, Partial<Session>> = {};
const authenticatedMetadata = new WeakSet<object>();

vi.mock('./storage', () => ({
    getOperationalSessionMetadata: (value: unknown) => (
        typeof value === 'object'
        && value !== null
        && authenticatedMetadata.has(value)
            ? value
            : null
    ),
    storage: {
        getState: () => ({ sessions: mockSessions }),
    },
}));

import { getAllCommands } from './suggestionCommands';

describe('suggestionCommands', () => {
    it('includes /goal in the default slash command suggestions', () => {
        const commands = getAllCommands('missing-session');

        expect(commands).toEqual(expect.arrayContaining([
            expect.objectContaining({
                command: 'goal',
                description: 'Set a session goal',
            }),
        ]));
    });

    it('includes skills only from authenticated session metadata', () => {
        const metadata = {
                path: '/tmp/project',
                host: 'localhost',
                skills: ['plan-to-beads', 'superpowers:brainstorming'],
        };
        mockSessions['codex-session'] = {
            metadata,
        } as Partial<Session>;

        expect(getAllCommands('codex-session')).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ command: 'plan-to-beads' }),
        ]));

        authenticatedMetadata.add(metadata);
        const commands = getAllCommands('codex-session');

        expect(commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: 'plan-to-beads' }),
            expect.objectContaining({ command: 'superpowers:brainstorming' }),
        ]));
    });
});
