import { describe, expect, it, vi } from 'vitest';

import { authorizeSocketScope } from './socketScope';

describe('WebSocket claimed scope authorization', () => {
    it('accepts a session scope only when it belongs to the authenticated account', async () => {
        const getSessionGeneration = vi.fn(async (accountId: string, sessionId: string) => (
            accountId === 'account-1' && sessionId === 'session-1' ? 1_234 : null
        ));

        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'session-scoped', sessionId: 'session-1' },
            { getSessionGeneration, getMachineGeneration: vi.fn() },
        )).resolves.toEqual({
            ok: true,
            scope: {
                clientType: 'session-scoped',
                sessionId: 'session-1',
                authorizationGeneration: 1_234,
            },
        });

        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'session-scoped', sessionId: 'foreign-session' },
            { getSessionGeneration, getMachineGeneration: vi.fn() },
        )).resolves.toEqual({ ok: false, error: 'Session scope is not authorized' });
    });

    it('accepts a machine scope only when it belongs to the authenticated account', async () => {
        const getMachineGeneration = vi.fn(async (accountId: string, machineId: string) => (
            accountId === 'account-1' && machineId === 'machine-1' ? 5_678 : null
        ));

        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'machine-scoped', machineId: 'machine-1' },
            { getSessionGeneration: vi.fn(), getMachineGeneration },
        )).resolves.toEqual({
            ok: true,
            scope: {
                clientType: 'machine-scoped',
                machineId: 'machine-1',
                authorizationGeneration: 5_678,
            },
        });

        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'machine-scoped', machineId: 'foreign-machine' },
            { getSessionGeneration: vi.fn(), getMachineGeneration },
        )).resolves.toEqual({ ok: false, error: 'Machine scope is not authorized' });
    });

    it('keeps user-scoped callers but rejects registration-scope smuggling', async () => {
        const lookups = { getSessionGeneration: vi.fn(), getMachineGeneration: vi.fn() };

        await expect(authorizeSocketScope('account-1', {}, lookups)).resolves.toEqual({
            ok: true,
            scope: { clientType: 'user-scoped' },
        });
        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'user-scoped', sessionId: 'session-1' },
            lookups,
        )).resolves.toEqual({ ok: false, error: 'User-scoped clients cannot claim a session or machine' });
        expect(lookups.getSessionGeneration).not.toHaveBeenCalled();
        expect(lookups.getMachineGeneration).not.toHaveBeenCalled();
    });

    it('rejects unknown client types, conflicting scopes, and malformed IDs', async () => {
        const lookups = { getSessionGeneration: vi.fn(), getMachineGeneration: vi.fn() };

        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'administrator' },
            lookups,
        )).resolves.toMatchObject({ ok: false });
        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'session-scoped', sessionId: 'session-1', machineId: 'machine-1' },
            lookups,
        )).resolves.toMatchObject({ ok: false });
        await expect(authorizeSocketScope(
            'account-1',
            { clientType: 'machine-scoped', machineId: 'x'.repeat(65) },
            lookups,
        )).resolves.toMatchObject({ ok: false });
    });
});
