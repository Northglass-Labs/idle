import type { Session } from '@/sync/storageTypes';
import { getOperationalSessionMetadata } from '@/sync/storage';

export type ClaudeForkSource = {
    kind: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

export type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

export type ForkSource = ClaudeForkSource | CodexForkSource;

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function getSessionForkSource(session: Session): ForkSource | null {
    const metadata = getOperationalSessionMetadata(session.metadata);
    const machineId = metadata?.machineId;
    const directory = metadata?.path;
    if (!nonEmpty(machineId) || !nonEmpty(directory)) {
        return null;
    }

    if (metadata?.flavor === 'codex') {
        const codexThreadId = metadata.codexThreadId;
        if (!nonEmpty(codexThreadId)) {
            return null;
        }
        return {
            kind: 'codex',
            sessionId: session.id,
            machineId,
            directory,
            codexThreadId,
        };
    }

    const claudeSessionId = metadata?.claudeSessionId;
    if (!nonEmpty(claudeSessionId)) {
        return null;
    }
    return {
        kind: 'claude',
        sessionId: session.id,
        machineId,
        directory,
        claudeSessionId,
    };
}
