import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    controlToken: 'OPAQUE_DOCTOR_CONTROL_TOKEN_3f9c',
    command: 'OPAQUE_DOCTOR_PROCESS_COMMAND_7d21',
    setting: 'OPAQUE_DOCTOR_SETTING_53ae',
    projectRoot: '/opaque/doctor/project-root-119a',
    idleHome: '/opaque/doctor/idle-home-2b6f',
    logsDir: '/opaque/doctor/logs-61c4',
    serverUrl: 'https://opaque-doctor-account.invalid',
    stateFile: '/opaque/doctor/daemon-state-88d2.json',
    daemonLogPath: '/opaque/doctor/daemon-log-a934.log',
    readSettings: vi.fn(),
    readCredentials: vi.fn(),
    readDaemonState: vi.fn(),
    checkDaemon: vi.fn(),
    findProcesses: vi.fn(),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        idleHomeDir: testState.idleHome,
        logsDir: testState.logsDir,
        serverUrl: testState.serverUrl,
        daemonStateFile: testState.stateFile,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: testState.readSettings,
    readCredentials: testState.readCredentials,
    readDaemonState: testState.readDaemonState,
}));

vi.mock('@/daemon/controlClient', () => ({
    checkIfDaemonRunningAndCleanupStaleState: testState.checkDaemon,
}));

vi.mock('@/daemon/doctor', () => ({ findAllIdleProcesses: testState.findProcesses }));
vi.mock('@/projectPath', () => ({ projectPath: () => testState.projectRoot }));

vi.mock('node:fs', async () => ({
    ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
}));

import { getEnvironmentInfo, runDoctorCommand, runDoctorDaemon } from './doctor';

const ENV_KEYS = [
    'PWD',
    'IDLE_HOME_DIR',
    'IDLE_VARIANT',
    'IDLE_SERVER_URL',
    'IDLE_PROJECT_ROOT',
    'NODE_ENV',
    'DEBUG',
] as const;

describe('doctor output privacy boundary', () => {
    const originalEnvironment = new Map<string, string | undefined>();
    let consoleLog: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of ENV_KEYS) {
            originalEnvironment.set(key, process.env[key]);
            process.env[key] = `OPAQUE_DOCTOR_ENV_${key}_c15e`;
        }

        testState.readSettings.mockResolvedValue({
            schemaVersion: 2,
            privateValue: testState.setting,
            sandboxConfig: { enabled: true, workspaceRoot: testState.projectRoot },
        });
        testState.readCredentials.mockResolvedValue({ token: 'opaque-token', secret: new Uint8Array(32) });
        testState.readDaemonState.mockResolvedValue({
            pid: 424242,
            httpPort: 45555,
            controlToken: testState.controlToken,
            startTime: '2026-07-13T00:00:00.000Z',
            startedWithCliVersion: '1.2.3',
            daemonLogPath: testState.daemonLogPath,
        });
        testState.checkDaemon.mockResolvedValue(true);
        testState.findProcesses.mockResolvedValue([
            { pid: 424242, command: testState.command, type: 'daemon' },
        ]);
        consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleLog.mockRestore();
        for (const key of ENV_KEYS) {
            const value = originalEnvironment.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        originalEnvironment.clear();
    });

    it('returns environment shape without account, path, argv, or identity values', () => {
        const output = JSON.stringify(getEnvironmentInfo());

        expect(output).not.toContain('OPAQUE_DOCTOR_ENV_');
        expect(output).not.toContain(testState.idleHome);
        expect(output).not.toContain(testState.logsDir);
        expect(output).not.toContain(testState.serverUrl);
        expect(output).not.toContain(process.cwd());
        expect(output).not.toContain(process.env.USER ?? '__missing_user__');
    });

    it('prints only allowlisted status metadata from daemon and full diagnostics', async () => {
        await runDoctorDaemon();
        await runDoctorCommand();

        const output = consoleLog.mock.calls.flat().map(String).join('\n');
        const forbidden = [
            testState.controlToken,
            testState.command,
            testState.setting,
            testState.projectRoot,
            testState.idleHome,
            testState.logsDir,
            testState.serverUrl,
            testState.stateFile,
            testState.daemonLogPath,
            '424242',
            '45555',
            'OPAQUE_DOCTOR_ENV_',
            'opaque-token',
        ];

        for (const value of forbidden) {
            expect(output).not.toContain(value);
        }
        expect(output).toContain('Daemon is running');
        expect(output).toContain('Authenticated');
    });
});
