import { describe, expect, it, vi } from 'vitest';
import {
    archiveCodexSessionMetadata,
    handleUnexpectedCodexBackendExit,
} from './runnerLifecycle';

describe('Codex runner lifecycle', () => {
    it('closes the runner queue and reports an unexpected backend exit once', () => {
        let shouldExit = false;
        const closeQueue = vi.fn();
        const reportExit = vi.fn();
        const requestExit = vi.fn(() => { shouldExit = true; });

        expect(handleUnexpectedCodexBackendExit({
            isExitRequested: () => shouldExit,
            requestExit,
            closeQueue,
            reportExit,
        })).toBe(true);
        expect(handleUnexpectedCodexBackendExit({
            isExitRequested: () => shouldExit,
            requestExit,
            closeQueue,
            reportExit,
        })).toBe(false);

        expect(requestExit).toHaveBeenCalledTimes(1);
        expect(closeQueue).toHaveBeenCalledTimes(1);
        expect(reportExit).toHaveBeenCalledTimes(1);
    });

    it('archives terminal metadata with a bounded product-owned reason', () => {
        expect(archiveCodexSessionMetadata({ lifecycleState: 'running', private: 'preserved' }, 'backend-exit', 1234)).toEqual({
            lifecycleState: 'archived',
            lifecycleStateSince: 1234,
            archivedBy: 'cli',
            archiveReason: 'Codex backend exited unexpectedly',
            private: 'preserved',
        });
        expect(archiveCodexSessionMetadata({}, 'session-ended', 5678).archiveReason).toBe('Session ended');
    });
});
