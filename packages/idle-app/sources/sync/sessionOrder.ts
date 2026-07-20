/**
 * Pure session ordering functions.
 *
 * These functions reorder session arrays based on a custom order (array of
 * session IDs). They have no side effects and no dependencies on RN, Expo,
 * or encryption — safe to unit-test in plain Node.
 *
 * Encrypted persistence lives in sessionOrderPersistence.ts.
 */

/**
 * Apply a custom ordering to a list of sessions.
 *
 * Sessions whose IDs appear in `customOrder` come first, in that order.
 * Sessions NOT in `customOrder` (new sessions) are appended at the end
 * in their original order. IDs in `customOrder` that don't match any
 * session (deleted sessions) are silently skipped.
 */
export function applySessionOrder<T extends { id: string }>(
    sessions: T[],
    customOrder: string[]
): T[] {
    if (customOrder.length === 0) {
        return sessions;
    }

    const sessionMap = new Map(sessions.map(s => [s.id, s]));
    const ordered: T[] = [];

    // First: sessions in custom order
    for (const id of customOrder) {
        const session = sessionMap.get(id);
        if (session) {
            ordered.push(session);
            sessionMap.delete(id);
        }
        // Stale IDs (deleted sessions) are silently skipped
    }

    // Then: any sessions not in the custom order (new sessions), preserving original order
    for (const session of sessions) {
        if (sessionMap.has(session.id)) {
            ordered.push(session);
        }
    }

    return ordered;
}

/**
 * Move a session to the top of the ordering.
 * Returns a new order array with the session ID prepended.
 * If the session was already in the order, it's removed from its old position.
 */
export function moveSessionToTop(
    currentOrder: string[],
    sessionId: string
): string[] {
    const filtered = currentOrder.filter(id => id !== sessionId);
    return [sessionId, ...filtered];
}

/**
 * Remove stale session IDs from the order array.
 * Only keeps IDs that exist in the provided set of valid session IDs.
 */
export function pruneSessionOrder(
    currentOrder: string[],
    validSessionIds: Set<string>
): string[] {
    return currentOrder.filter(id => validSessionIds.has(id));
}

// === V2: Session Groups ===

export interface SessionGroup {
    id: string;
    name: string;
    sessionIds: string[];
}

export interface SessionOrderV2 {
    version: 2;
    groups: SessionGroup[];
    ungrouped: string[];
}

export type SessionOrderData = string[] | SessionOrderV2;

/** Detect and normalize stored data to V2 format */
export function normalizeSessionOrder(data: unknown): SessionOrderV2 {
    if (Array.isArray(data)) {
        return migrateV1toV2(data);
    }
    if (data && typeof data === 'object' && 'version' in data && (data as any).version === 2) {
        return data as SessionOrderV2;
    }
    return { version: 2, groups: [], ungrouped: [] };
}

export function migrateV1toV2(v1: string[]): SessionOrderV2 {
    return { version: 2, groups: [], ungrouped: [...v1] };
}

export function createGroup(order: SessionOrderV2, id: string, name: string): SessionOrderV2 {
    return {
        ...order,
        groups: [...order.groups, { id, name, sessionIds: [] }]
    };
}

export function deleteGroup(order: SessionOrderV2, groupId: string): SessionOrderV2 {
    const group = order.groups.find(g => g.id === groupId);
    if (!group) return order;
    return {
        ...order,
        groups: order.groups.filter(g => g.id !== groupId),
        ungrouped: [...group.sessionIds, ...order.ungrouped]
    };
}

export function renameGroup(order: SessionOrderV2, groupId: string, name: string): SessionOrderV2 {
    return {
        ...order,
        groups: order.groups.map(g => g.id === groupId ? { ...g, name } : g)
    };
}

/**
 * Apply a flat ordered sequence of (session-id, container) tuples back into
 * the V2 order structure. Used by drag-to-reorder: after the user drops, the
 * UI walks the new visual order and emits one tuple per session showing where
 * it landed (which group id, or null for ungrouped). This function rebuilds
 * the V2 order to match — preserving group definitions (name/id) but
 * replacing each group's sessionIds with the new sequence.
 *
 * Sessions that disappear from the sequence (e.g. dropped from a group with
 * no replacement) end up in `ungrouped` so we never lose a session ID. Groups
 * not represented in the sequence keep their existing members untouched.
 */
export function rebuildOrderFromDragSequence(
    currentOrder: SessionOrderV2,
    sequence: Array<{ sessionId: string; containerGroupId: string | null }>,
): SessionOrderV2 {
    const newGroupSessions: Record<string, string[]> = {};
    for (const g of currentOrder.groups) newGroupSessions[g.id] = [];
    const newUngrouped: string[] = [];
    const groupsTouched = new Set<string>();
    const seenSessions = new Set<string>();

    for (const { sessionId, containerGroupId } of sequence) {
        if (seenSessions.has(sessionId)) continue;
        seenSessions.add(sessionId);
        if (containerGroupId === null) {
            newUngrouped.push(sessionId);
        } else if (newGroupSessions[containerGroupId] !== undefined) {
            newGroupSessions[containerGroupId].push(sessionId);
            groupsTouched.add(containerGroupId);
        } else {
            // Unknown group id — defensively park the session ungrouped
            newUngrouped.push(sessionId);
        }
    }

    // For groups the sequence didn't mention at all, preserve their existing
    // member ordering. Drag-mode UI hides groups it can't move; not touching
    // those groups protects them from accidental clearing.
    for (const g of currentOrder.groups) {
        if (!groupsTouched.has(g.id)) {
            newGroupSessions[g.id] = [...g.sessionIds];
        }
    }

    // Preserve omitted V2.ungrouped sessions in their existing order so a
    // partial sequence cannot delete a session ID.
    for (const id of currentOrder.ungrouped) {
        if (!seenSessions.has(id)) newUngrouped.push(id);
    }

    return {
        version: 2,
        groups: currentOrder.groups.map(g => ({
            ...g,
            sessionIds: newGroupSessions[g.id] ?? [],
        })),
        ungrouped: newUngrouped,
    };
}

/**
 * Reorder sessions within the ungrouped bucket.
 *
 * `newOrder` is the desired ordering of the ungrouped IDs. IDs not currently
 * in the ungrouped bucket are silently dropped; omitted existing IDs are
 * appended at the end so a malformed update cannot lose sessions.
 */
export function reorderUngrouped(
    order: SessionOrderV2,
    newOrder: string[]
): SessionOrderV2 {
    const existing = new Set(order.ungrouped);
    const reordered: string[] = [];
    const seen = new Set<string>();
    for (const id of newOrder) {
        if (existing.has(id) && !seen.has(id)) {
            reordered.push(id);
            seen.add(id);
        }
    }
    for (const id of order.ungrouped) {
        if (!seen.has(id)) reordered.push(id);
    }
    return { ...order, ungrouped: reordered };
}

/**
 * Reorder sessions within a single group's sessionIds list.
 *
 * Same defensive behavior as `reorderUngrouped`: unknown IDs are dropped and
 * omitted existing IDs are appended.
 */
export function reorderSessionsInGroup(
    order: SessionOrderV2,
    groupId: string,
    newOrder: string[]
): SessionOrderV2 {
    const idx = order.groups.findIndex(g => g.id === groupId);
    if (idx < 0) return order;
    const existing = new Set(order.groups[idx].sessionIds);
    const reordered: string[] = [];
    const seen = new Set<string>();
    for (const id of newOrder) {
        if (existing.has(id) && !seen.has(id)) {
            reordered.push(id);
            seen.add(id);
        }
    }
    for (const id of order.groups[idx].sessionIds) {
        if (!seen.has(id)) reordered.push(id);
    }
    const newGroups = [...order.groups];
    newGroups[idx] = { ...newGroups[idx], sessionIds: reordered };
    return { ...order, groups: newGroups };
}

export function moveSessionToGroup(
    order: SessionOrderV2,
    sessionId: string,
    groupId: string | null
): SessionOrderV2 {
    // Remove session from everywhere first
    const newGroups = order.groups.map(g => ({
        ...g,
        sessionIds: g.sessionIds.filter(id => id !== sessionId)
    }));
    let newUngrouped = order.ungrouped.filter(id => id !== sessionId);

    if (groupId === null) {
        newUngrouped = [sessionId, ...newUngrouped];
    } else {
        const targetIdx = newGroups.findIndex(g => g.id === groupId);
        if (targetIdx >= 0) {
            newGroups[targetIdx] = {
                ...newGroups[targetIdx],
                sessionIds: [sessionId, ...newGroups[targetIdx].sessionIds]
            };
        }
    }

    return { ...order, groups: newGroups, ungrouped: newUngrouped };
}

export interface GroupedResult<T extends { id: string }> {
    grouped: Array<{ group: SessionGroup; sessions: T[] }>;
    ungrouped: T[];
}

// Structural type for the existing date-grouped view items (see
// sync/storage.ts: SessionListViewItem). Re-declared here as a pure type so
// `combineGroupedListData` lives in this RN-free file and stays unit-testable.
// Kept in sync by structural compatibility; SessionListViewItem in storage.ts
// must remain a superset of this shape.
export type BaseListItem<S extends { id: string }> =
    | { type: 'header'; title: string }
    | { type: 'active-sessions'; sessions: S[] }
    | { type: 'project-group'; displayPath: string; machine: { id: string; metadata?: any } }
    | { type: 'session'; session: S; variant?: 'default' | 'no-path' };

export type GroupedListItem<S extends { id: string }> =
    | BaseListItem<S>
    | { type: 'group-header'; group: SessionGroup; sessionCount: number; isExpanded: boolean }
    | { type: 'group-session'; group: SessionGroup; session: S; isFirstInGroup: boolean; isLastInGroup: boolean };

export interface GroupedListResult<S extends { id: string }> {
    items: GroupedListItem<S>[];
    hasGroups: boolean;
}

/**
 * Pure combiner that merges the date-grouped view data with V2 group order.
 *
 * Behavior:
 *  - If V2 is empty (no groups, no explicit ungrouped order): return
 *    `baseData` untouched (reference-equal). Users who never touched V2 see
 *    zero behavioral change.
 *  - If groups exist: emit group sections at the top, then the remaining
 *    date-bucketed sessions below with grouped IDs filtered out so a session
 *    never renders twice.
 *  - If V2.ungrouped has explicit ordering: within each date bucket
 *    (`header` → consecutive `session` items), sessions that appear in
 *    V2.ungrouped sort to the top in V2 order. Sessions not in V2.ungrouped
 *    keep their original (createdAt) position. This lets drag-to-reorder
 *    work on ungrouped/date-bucketed sessions without modifying
 *    `buildSessionListViewData` in storage.ts.
 */
export function combineGroupedListData<S extends { id: string }>(
    baseData: BaseListItem<S>[],
    order: SessionOrderV2,
    collapsedGroups: Record<string, boolean>,
): GroupedListResult<S> {
    const hasGroups = order.groups.length > 0;
    const hasUngroupedOrder = order.ungrouped.length > 0;
    if (!hasGroups && !hasUngroupedOrder) {
        return { items: baseData, hasGroups: false };
    }

    const allSessions: S[] = [];
    for (const item of baseData) {
        if (item.type === 'session') {
            allSessions.push(item.session);
        } else if (item.type === 'active-sessions') {
            for (const s of item.sessions) allSessions.push(s);
        }
    }

    const grouped = applySessionOrderV2(allSessions, order);
    const groupedSessionIds = new Set<string>();
    for (const g of grouped.grouped) {
        for (const s of g.sessions) groupedSessionIds.add(s.id);
    }

    // Index of each session in V2.ungrouped — used to sort within date
    // buckets. Sessions not in the map keep their original (createdAt) order.
    const ungroupedIndex = new Map<string, number>();
    order.ungrouped.forEach((id, idx) => ungroupedIndex.set(id, idx));

    const out: GroupedListItem<S>[] = [];

    // Cross-bucket Move-to-top uses a dedicated pinned tier.
    //
    // V2-pinned sessions hoist to a synthetic "Pinned" header regardless of
    // active state. This keeps an explicit user order independent from the
    // active-session bucket's lastSeen sorting.
    //
    // Tradeoff: the visual "live indicator" treatment moves with the row to
    // the Pinned section. Session rows already render their own online dot
    // / activity timestamp independent of which section they're in, so the
    // affordance survives the migration.
    //
    // All V2.ungrouped sessions hoist across date and activity buckets. Sorting
    // only within a bucket would make Move-to-top appear ineffective, while
    // leaving active rows behind would reintroduce the lastSeen-vs-pinned conflict.
    const pinnedHoistedIds = new Set<string>();
    if (order.ungrouped.length > 0) {
        const sessionById = new Map<string, S>();
        for (const s of allSessions) {
            if (!groupedSessionIds.has(s.id)) {
                sessionById.set(s.id, s);
            }
        }
        const pinnedInOrder: S[] = [];
        for (const id of order.ungrouped) {
            const session = sessionById.get(id);
            if (session) {
                pinnedInOrder.push(session);
                pinnedHoistedIds.add(id);
            }
        }
        if (pinnedInOrder.length > 0) {
            out.push({ type: 'header', title: 'Pinned' });
            for (const session of pinnedInOrder) {
                out.push({ type: 'session', session });
            }
        }
    }

    for (const { group, sessions } of grouped.grouped) {
        if (sessions.length === 0) continue;
        const isExpanded = !collapsedGroups[group.id];
        out.push({
            type: 'group-header',
            group,
            sessionCount: sessions.length,
            isExpanded,
        });
        if (isExpanded) {
            sessions.forEach((session, idx) => {
                out.push({
                    type: 'group-session',
                    group,
                    session,
                    isFirstInGroup: idx === 0,
                    isLastInGroup: idx === sessions.length - 1,
                });
            });
        }
    }

    // Walk baseData, accumulating sessions until we hit a header (or non-bucket
    // item). Then emit the header + the bucket's sessions, applying V2.ungrouped
    // ordering on top of createdAt.
    let bucket: S[] = [];
    let pendingHeader: BaseListItem<S> | null = null;
    const flushBucket = () => {
        if (bucket.length === 0) {
            pendingHeader = null;
            return;
        }
        const explicit = bucket.filter(s => ungroupedIndex.has(s.id));
        const rest = bucket.filter(s => !ungroupedIndex.has(s.id));
        explicit.sort((a, b) => (ungroupedIndex.get(a.id)! - ungroupedIndex.get(b.id)!));
        if (pendingHeader) out.push(pendingHeader);
        for (const session of [...explicit, ...rest]) {
            out.push({ type: 'session', session });
        }
        bucket = [];
        pendingHeader = null;
    };

    for (const item of baseData) {
        if (item.type === 'header') {
            flushBucket();
            pendingHeader = item;
            continue;
        }
        if (item.type === 'session') {
            if (groupedSessionIds.has(item.session.id)) continue;
            if (pinnedHoistedIds.has(item.session.id)) continue;
            bucket.push(item.session);
            continue;
        }
        // Non-session, non-header items terminate the current bucket.
        flushBucket();
        if (item.type === 'active-sessions') {
            // Filter both grouped sessions (rendered under group headers)
            // and V2-pinned sessions (now hoisted to the Pinned section per
            // pinned-tier option a). The remaining active sessions keep their
            // natural lastSeen order with no internal V2 sort applied.
            const filtered = item.sessions.filter(
                s => !groupedSessionIds.has(s.id) && !pinnedHoistedIds.has(s.id)
            );
            if (filtered.length === 0) continue;
            out.push({ type: 'active-sessions', sessions: filtered });
            continue;
        }
        out.push(item);
    }
    flushBucket();

    return { items: out, hasGroups };
}

export function applySessionOrderV2<T extends { id: string }>(
    sessions: T[],
    order: SessionOrderV2
): GroupedResult<T> {
    const sessionMap = new Map(sessions.map(s => [s.id, s]));
    const consumed = new Set<string>();

    const grouped = order.groups.map(group => {
        const groupSessions: T[] = [];
        for (const id of group.sessionIds) {
            const session = sessionMap.get(id);
            if (session && !consumed.has(id)) {
                groupSessions.push(session);
                consumed.add(id);
            }
        }
        return { group, sessions: groupSessions };
    });

    const ungrouped: T[] = [];
    for (const id of order.ungrouped) {
        const session = sessionMap.get(id);
        if (session && !consumed.has(id)) {
            ungrouped.push(session);
            consumed.add(id);
        }
    }
    // Append any sessions not referenced in the order at all
    for (const session of sessions) {
        if (!consumed.has(session.id)) {
            ungrouped.push(session);
        }
    }

    return { grouped, ungrouped };
}
