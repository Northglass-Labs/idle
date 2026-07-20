/**
 * Canonical "when was this session last actually doing something" timestamp.
 *
 * The Session record has two adjacent number fields that drift apart:
 *   - activeAt:  bumps on real session activity (user messages, tool calls, model responses)
 *   - updatedAt: bumps on ANY metadata change — sync pings, title updates, status reports
 *
 * Every "last seen" surface prefers `activeAt`, which represents user or agent
 * activity. `updatedAt` is only a fallback because metadata and sync traffic can
 * advance it without meaningful session activity.
 *
 * Structural input type (no `Session` import) keeps this file out of the React-Native module
 * chain so it remains unit-testable in node vitest.
 */
export function getSessionLastSeenTimestamp(
    session: { activeAt: number; updatedAt: number }
): number {
    return session.activeAt || session.updatedAt || 0;
}
