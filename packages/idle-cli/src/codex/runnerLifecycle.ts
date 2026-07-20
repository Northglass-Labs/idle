export type CodexExitReason = 'backend-exit' | 'session-ended';

export function handleUnexpectedCodexBackendExit(options: {
    isExitRequested: () => boolean;
    requestExit: () => void;
    closeQueue: () => void;
    reportExit: () => void;
}): boolean {
    if (options.isExitRequested()) return false;
    options.requestExit();
    options.closeQueue();
    options.reportExit();
    return true;
}

export function archiveCodexSessionMetadata<T extends object>(
    currentMetadata: T,
    reason: CodexExitReason,
    now: number = Date.now(),
): T & {
    lifecycleState: 'archived';
    lifecycleStateSince: number;
    archivedBy: 'cli';
    archiveReason: string;
} {
    return {
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: now,
        archivedBy: 'cli',
        archiveReason: reason === 'backend-exit'
            ? 'Codex backend exited unexpectedly'
            : 'Session ended',
    };
}
