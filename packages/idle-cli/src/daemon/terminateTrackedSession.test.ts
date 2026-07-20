import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';
import { getTerminationTarget, terminateTrackedSession } from './terminateTrackedSession';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
    return {
        startedBy: 'daemon',
        idleSessionId: 'session-1',
        pid: 4242,
        ...overrides,
    };
}

function processError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('getTerminationTarget', () => {
    it('targets the whole detached process group for daemon-spawned sessions on POSIX', () => {
        expect(getTerminationTarget(trackedSession(), 'linux')).toBe(-4242);
        expect(getTerminationTarget(trackedSession(), 'darwin')).toBe(-4242);
    });

    it('does not widen external or Windows termination to a process group', () => {
        expect(getTerminationTarget(trackedSession({ startedBy: 'external' }), 'linux')).toBe(4242);
        expect(getTerminationTarget(trackedSession(), 'win32')).toBe(4242);
    });
});

describe('terminateTrackedSession', () => {
    it('falls back to the individual PID when an expected process group is absent', async () => {
        let pidAlive = true;
        const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0) {
                if (pid < 0) throw processError('ESRCH');
                if (pidAlive) return true;
                throw processError('ESRCH');
            }
            if (pid === 4242 && signal === 'SIGTERM') {
                pidAlive = false;
            }
            return true;
        });

        await expect(terminateTrackedSession(trackedSession(), {
            gracefulTimeoutMs: 0,
            forceTimeoutMs: 0,
        })).resolves.toBe(true);

        expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    });

    it('confirms the target exited after SIGTERM', async () => {
        let alive = true;
        const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            if (signal === 0) {
                if (alive) return true;
                throw processError('ESRCH');
            }
            if (signal === 'SIGTERM') {
                alive = false;
            }
            return true;
        });

        await expect(terminateTrackedSession(trackedSession(), {
            gracefulTimeoutMs: 0,
            forceTimeoutMs: 0,
        })).resolves.toBe(true);

        expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    });

    it('escalates to SIGKILL and confirms the target exited', async () => {
        let alive = true;
        const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            if (signal === 0) {
                if (alive) return true;
                throw processError('ESRCH');
            }
            if (signal === 'SIGKILL') {
                alive = false;
            }
            return true;
        });

        await expect(terminateTrackedSession(trackedSession(), {
            gracefulTimeoutMs: 0,
            forceTimeoutMs: 0,
        })).resolves.toBe(true);

        expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
    });

    it('returns false when the target cannot be signaled', async () => {
        vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            if (signal === 0) return true;
            throw processError('EPERM');
        });

        await expect(terminateTrackedSession(trackedSession(), {
            gracefulTimeoutMs: 0,
            forceTimeoutMs: 0,
        })).resolves.toBe(false);
    });

    it('returns false when the target remains after forced termination', async () => {
        const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

        await expect(terminateTrackedSession(trackedSession(), {
            gracefulTimeoutMs: 0,
            forceTimeoutMs: 0,
        })).resolves.toBe(false);

        expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL');
    });
});
