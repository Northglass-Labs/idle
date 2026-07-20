/** Pure parser and serializer for per-session usage snapshots. */

export interface LatestUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    contextSize: number;
    timestamp: number;
}

export function parseLatestUsage(raw: string): LatestUsage | null {
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const u = obj as Record<string, unknown>;
    if (
        typeof u.inputTokens === 'number' &&
        typeof u.outputTokens === 'number' &&
        typeof u.cacheCreation === 'number' &&
        typeof u.cacheRead === 'number' &&
        typeof u.contextSize === 'number' &&
        typeof u.timestamp === 'number'
    ) {
        return {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheCreation: u.cacheCreation,
            cacheRead: u.cacheRead,
            contextSize: u.contextSize,
            timestamp: u.timestamp,
        };
    }
    return null;
}

export function serializeLatestUsage(usage: LatestUsage): string {
    return JSON.stringify(usage);
}
