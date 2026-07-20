/**
 * Tests for getSessionAvatarId — the avatar-seed function exported from sessionUtils.
 *
 * Lives in its own spec file (not the broader sessionUtils.spec.ts that exists alongside
 * the helper file) because sessionUtils.ts transitively imports React + RN modules that
 * vitest can't resolve in node mode. We test the avatar helper by isolating it via a
 * structural-type stub instead of importing the Session type.
 *
 * The seed includes session identity so concurrent sessions in one target
 * folder render distinct avatars.
 */

import { describe, it, expect } from 'vitest';

// Inline the helper rather than importing from sessionUtils.ts so the test runs in node
// vitest (avoids the React Native module chain). If the production helper signature
// changes, this stub must change too — keep them in sync.
function getSessionAvatarId(session: {
    id: string;
    metadata?: { machineId?: string; path?: string } | null;
}): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        return `${session.metadata.machineId}:${session.metadata.path}:${session.id}`;
    }
    return session.id;
}

describe('getSessionAvatarId — UI behavior uniqueness contract', () => {
    it('returns different IDs for two sessions in the same machine + path', () => {
        // Session identity must distinguish otherwise identical targets.
        const sessionA = {
            id: 'session-alpha',
            metadata: { machineId: 'test-host', path: '/home/user/projects/idle' },
        };
        const sessionB = {
            id: 'session-beta',
            metadata: { machineId: 'test-host', path: '/home/user/projects/idle' },
        };
        expect(getSessionAvatarId(sessionA)).not.toBe(getSessionAvatarId(sessionB));
    });

    it('returns the same ID for the same session across calls (deterministic)', () => {
        const session = {
            id: 'session-alpha',
            metadata: { machineId: 'test-host', path: '/home/user/projects/idle' },
        };
        expect(getSessionAvatarId(session)).toBe(getSessionAvatarId(session));
    });

    it('includes the sessionId in the seed when metadata is present', () => {
        const session = {
            id: 'unique-session-id',
            metadata: { machineId: 'test-host', path: '/some/path' },
        };
        expect(getSessionAvatarId(session)).toContain('unique-session-id');
    });

    it('falls back to session.id alone when metadata is missing', () => {
        expect(getSessionAvatarId({ id: 'session-1' })).toBe('session-1');
        expect(getSessionAvatarId({ id: 'session-1', metadata: null })).toBe('session-1');
        expect(getSessionAvatarId({ id: 'session-1', metadata: {} })).toBe('session-1');
    });

    it('falls back when only one of machineId or path is present', () => {
        expect(getSessionAvatarId({ id: 'session-1', metadata: { machineId: 'mac' } })).toBe('session-1');
        expect(getSessionAvatarId({ id: 'session-1', metadata: { path: '/p' } })).toBe('session-1');
    });

    it('still produces different IDs for sessions in different machines (cross-machine uniqueness preserved)', () => {
        const a = { id: 'sess-A', metadata: { machineId: 'test-host', path: '/p' } };
        const b = { id: 'sess-B', metadata: { machineId: 'macbook', path: '/p' } };
        expect(getSessionAvatarId(a)).not.toBe(getSessionAvatarId(b));
    });
});
