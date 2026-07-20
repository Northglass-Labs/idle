import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    token: 'OPAQUE_AUTH_STATUS_BEARER_4517',
    machineId: 'OPAQUE_AUTH_MACHINE_ID_d913',
    hostname: 'OPAQUE_AUTH_HOSTNAME_7ac2',
    idleHome: '/opaque/auth/data-directory-32af',
    serverUrl: 'https://opaque-auth-account.invalid',
    readCredentials: vi.fn(),
    readSettings: vi.fn(),
    clearCredentials: vi.fn(),
    clearMachineId: vi.fn(),
    authenticate: vi.fn(),
    axiosGet: vi.fn(),
    checkDaemon: vi.fn(),
}));

vi.mock('axios', () => ({ default: { get: testState.axiosGet } }));
vi.mock('@/persistence', () => ({
    readCredentials: testState.readCredentials,
    readSettings: testState.readSettings,
    clearCredentials: testState.clearCredentials,
    clearMachineId: testState.clearMachineId,
}));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: testState.authenticate }));
vi.mock('@/configuration', () => ({
    configuration: {
        idleHomeDir: testState.idleHome,
        serverUrl: testState.serverUrl,
        currentCliVersion: '1.2.3',
    },
}));
vi.mock('@/daemon/controlClient', () => ({
    stopDaemon: vi.fn(),
    checkIfDaemonRunningAndCleanupStaleState: testState.checkDaemon,
}));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('node:os', () => ({ default: { hostname: () => testState.hostname } }));

import { handleAuthCommand } from './auth';

describe('auth command output privacy boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        testState.axiosGet.mockResolvedValue({ status: 200 });
        testState.checkDaemon.mockResolvedValue(true);
        testState.authenticate.mockResolvedValue({ machineId: testState.machineId });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function output(): string {
        return [
            ...vi.mocked(console.log).mock.calls,
            ...vi.mocked(console.error).mock.calls,
        ].flat().map(String).join('\n');
    }

    function expectNoLocalIdentity(text: string): void {
        for (const forbidden of [
            testState.token,
            testState.token.slice(0, 30),
            testState.machineId,
            testState.hostname,
            testState.idleHome,
            testState.serverUrl,
        ]) {
            expect(text).not.toContain(forbidden);
        }
    }

    it('reports authenticated status without token previews or machine, host, URL, and path values', async () => {
        testState.readCredentials.mockResolvedValue({ token: testState.token, secret: new Uint8Array(32) });
        testState.readSettings.mockResolvedValue({ machineId: testState.machineId });

        await handleAuthCommand(['status']);

        expectNoLocalIdentity(output());
        expect(output()).toContain('Authenticated');
        expect(output()).toContain('Machine registered');
        expect(output()).toContain('Daemon running');
        expect(testState.axiosGet.mock.calls[0][1]).toMatchObject({ maxRedirects: 0 });
    });

    it('does not echo an existing or newly registered machine identity during login', async () => {
        testState.readCredentials.mockResolvedValueOnce({ token: testState.token, secret: new Uint8Array(32) });
        testState.readSettings.mockResolvedValueOnce({ machineId: testState.machineId });
        await handleAuthCommand(['login']);
        expectNoLocalIdentity(output());

        vi.mocked(console.log).mockClear();
        testState.readCredentials.mockResolvedValueOnce(null);
        testState.readSettings.mockResolvedValueOnce({});
        await handleAuthCommand(['login']);
        expectNoLocalIdentity(output());
        expect(output()).toContain('Authentication successful');
    });
});
