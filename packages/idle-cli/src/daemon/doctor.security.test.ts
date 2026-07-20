import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    command: 'node /opaque/idle.mjs daemon start --provider-session OPAQUE_DAEMON_DOCTOR_COMMAND_41da',
    error: 'OPAQUE_DAEMON_DOCTOR_ERROR_f30b',
    pid: 987654,
    psList: vi.fn(),
}));

vi.mock('ps-list', () => ({ default: testState.psList }));
vi.mock('cross-spawn', () => ({ default: { sync: vi.fn() } }));

import { findAllIdleProcesses, killRunawayIdleProcesses } from './doctor';

describe('daemon doctor privacy boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        testState.psList.mockResolvedValue([
            { pid: testState.pid, name: 'idle', cmd: testState.command },
        ]);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw new Error(testState.error);
        });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('classifies processes without returning their raw commands', async () => {
        const processes = await findAllIdleProcesses();

        expect(processes).toEqual([{ pid: testState.pid, type: 'daemon' }]);
        expect(JSON.stringify(processes)).not.toContain(testState.command);
    });

    it('reports only aggregate cleanup failures without identifiers or raw errors', async () => {
        const result = await killRunawayIdleProcesses();
        const output = vi.mocked(console.log).mock.calls.flat().map(String).join('\n');

        expect(result).toEqual({ killed: 0, failed: 1 });
        expect(JSON.stringify(result)).not.toContain(String(testState.pid));
        expect(JSON.stringify(result)).not.toContain(testState.error);
        expect(output).not.toContain(String(testState.pid));
        expect(output).not.toContain(testState.command);
        expect(output).not.toContain(testState.error);
    });
});
