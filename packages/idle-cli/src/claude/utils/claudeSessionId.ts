const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude stores session transcripts under UUID-named JSONL files. Keep every
 * caller on the same filename-safe rule before a session ID reaches a path or
 * child-process boundary.
 */
export function isValidClaudeSessionId(value: unknown): value is string {
    return typeof value === 'string' && CLAUDE_SESSION_ID_RE.test(value);
}
