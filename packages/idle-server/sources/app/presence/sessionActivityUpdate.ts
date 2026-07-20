/**
 * Pure Prisma update-arg builders for session presence transitions.
 *
 * Security invariant:
 * A session could show "active 16 min ago" on the home list even though the
 * underlying Claude Code process had been dead for ~24 hours. The trace:
 *
 *   1. CLI daemon sends periodic `session-alive` heartbeats for every session it knows about.
 *   2. The `sessionCache.flushPendingUpdates` path used `db.session.update({...data: { lastActiveAt, active: true }})`,
 *      unconditionally setting `active: true` on every flush.
 *   3. The `presence/timeout.ts` job marks sessions inactive after 10 min of no heartbeat.
 *   4. When the daemon enters a partial-sleep state, heartbeats arrive intermittently. The
 *      timeout fires, marks `active: false`. The next phantom heartbeat resurrects `active: true`.
 *      The cycle repeats indefinitely.
 *
 * The fix: split the update paths.
 *
 *   - `buildHeartbeatUpdateArgs` — heartbeats can bump `lastActiveAt` for STILL-ACTIVE sessions
 *     (so the `presence/timeout` query continues to see fresh data and won't expire them) but
 *     they CANNOT touch `active`. A session that the timeout has marked inactive stays inactive
 *     until real activity (`buildActivityResumeUpdateArgs`) arrives.
 *
 *   - `buildActivityResumeUpdateArgs` — real activity (a `message` socket event) sets `active: true`
 *     unconditionally. This is the ONLY way to resurrect a timed-out session, which matches user
 *     intent: when you actually engage with a stale session by sending a message, it comes back to life.
 *
 * The split keeps the user-visible UX honest. A laptop closed for 30 min then reopened will show
 * "Last seen 30 min ago" until the user sends a real message, at which point the session goes
 * back to "Active now." Phantom heartbeats from a dead-Claude-process daemon are correctly
 * ignored.
 *
 * Deeper CLI-side fix (the daemon should stop heartbeating for sessions whose underlying process
 * has exited) is tracked separately. This server-side defense holds whether or not the CLI fix
 * ever ships.
 *
 * Pure / dependency-free so the contract is unit-testable in plain vitest without a DB.
 */

export interface SessionUpdateArgs {
    where: { id: string; active?: true };
    data: { lastActiveAt: Date; active?: true };
}

/**
 * Update args for the `session-alive` heartbeat path.
 *
 * Scopes the update with `where: { active: true }` so heartbeats never touch sessions that the
 * timeout job has already marked inactive. The `data` does NOT include `active` at all (the
 * column stays whatever it was — `true` for surviving sessions, untouched for skipped ones).
 */
export function buildHeartbeatUpdateArgs(args: {
    sessionId: string;
    timestamp: number;
}): SessionUpdateArgs {
    return {
        where: { id: args.sessionId, active: true },
        data: { lastActiveAt: new Date(args.timestamp) },
    };
}

/**
 * Update args for the "real activity arrived" path (message events, etc.).
 *
 * Unconditional: updates regardless of current `active` state, and explicitly sets `active: true`.
 * This is the only legitimate resurrection path for a session the timeout has marked inactive.
 */
export function buildActivityResumeUpdateArgs(args: {
    sessionId: string;
    timestamp: number;
}): SessionUpdateArgs {
    return {
        where: { id: args.sessionId },
        data: { lastActiveAt: new Date(args.timestamp), active: true },
    };
}
