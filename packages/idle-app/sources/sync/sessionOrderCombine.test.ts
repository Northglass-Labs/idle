import { describe, it, expect } from 'vitest';
import {
    combineGroupedListData,
    BaseListItem,
    SessionOrderV2,
    reorderUngrouped,
    reorderSessionsInGroup,
    rebuildOrderFromDragSequence,
} from './sessionOrder';

type S = { id: string };
function s(id: string): S {
    return { id };
}

function emptyOrder(): SessionOrderV2 {
    return { version: 2, groups: [], ungrouped: [] };
}

describe('combineGroupedListData', () => {
    it('returns the base data unchanged when no groups exist', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
        ];
        const result = combineGroupedListData(baseData, emptyOrder(), {});
        expect(result.hasGroups).toBe(false);
        expect(result.items).toBe(baseData);
    });

    it('emits group header + members at top and removes them from date buckets', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
            { type: 'session', session: s('c') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'c'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, {});

        expect(result.hasGroups).toBe(true);
        const types = result.items.map(i => i.type);
        expect(types).toEqual(['group-header', 'group-session', 'group-session', 'header', 'session']);

        const firstGroupSession = result.items[1];
        const secondGroupSession = result.items[2];
        const surviving = result.items[4];
        if (firstGroupSession.type !== 'group-session' || secondGroupSession.type !== 'group-session' || surviving.type !== 'session') {
            throw new Error('shape narrowing failed');
        }
        expect(firstGroupSession.session.id).toBe('a');
        expect(firstGroupSession.isFirstInGroup).toBe(true);
        expect(firstGroupSession.isLastInGroup).toBe(false);
        expect(secondGroupSession.session.id).toBe('c');
        expect(secondGroupSession.isFirstInGroup).toBe(false);
        expect(secondGroupSession.isLastInGroup).toBe(true);
        expect(surviving.session.id).toBe('b');
    });

    it('collapses a group: header still renders, members do not', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, { g1: true });

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['group-header']);
        const header = result.items[0];
        if (header.type !== 'group-header') throw new Error('shape narrowing failed');
        expect(header.isExpanded).toBe(false);
        expect(header.sessionCount).toBe(2);
    });

    it('drops empty groups (all member IDs deleted) entirely', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'session', session: s('a') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Empty', sessionIds: ['ghost-1', 'ghost-2'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['session']);
    });

    it('filters grouped sessions out of an active-sessions bucket', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'active-sessions', sessions: [s('a'), s('b'), s('c')] },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['group-header', 'group-session', 'active-sessions']);

        const active = result.items[2];
        if (active.type !== 'active-sessions') throw new Error('shape narrowing failed');
        expect(active.sessions.map(x => x.id)).toEqual(['b', 'c']);
    });

    it('hoists pinned active sessions to the Pinned tier above active-sessions (pinned-tier option a)', () => {
        // Active V2-pinned sessions hoist to the top Pinned tier, leaving the
        // active-sessions bucket with only un-pinned active rows. Keeping the
        // tiers separate prevents render-layer last-seen sorting from
        // overriding the user's pinned order.
        const baseData: BaseListItem<S>[] = [
            { type: 'active-sessions', sessions: [s('a'), s('b'), s('c'), s('d')] },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['c', 'a'],
        };
        const result = combineGroupedListData(baseData, order, {});

        // Pinned tier at the top, in V2 order
        expect(result.items[0]).toEqual({ type: 'header', title: 'Pinned' });
        expect((result.items[1] as any).session.id).toBe('c');
        expect((result.items[2] as any).session.id).toBe('a');

        // active-sessions now only contains the un-pinned rows
        const active = result.items[3];
        if (active.type !== 'active-sessions') throw new Error('shape narrowing failed');
        expect(active.sessions.map(x => x.id)).toEqual(['b', 'd']);
    });

    it('hoists inactive pinned sessions into a top Pinned header (cross-bucket move-to-top)', () => {
        // "Move to top" on an inactive session from a date bucket writes to
        // V2.ungrouped; sorting only
        // sort within that bucket — visually nothing changed at the screen
        // level. Now inactive pinned sessions lift to a synthetic top group.
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
            { type: 'header', title: '3 days ago' },
            { type: 'session', session: s('c') },
            { type: 'session', session: s('d') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['d', 'b'],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual([
            'header',  // Pinned
            'session', 'session',  // d, b in V2 order
            'header',  // Today
            'session',  // a (b was hoisted)
            'header',  // 3 days ago
            'session',  // c (d was hoisted)
        ]);
        const headers = result.items.filter(i => i.type === 'header').map(i => (i as any).title);
        expect(headers).toEqual(['Pinned', 'Today', '3 days ago']);
        const pinnedSessions = result.items
            .slice(1, 3)
            .map(i => (i as any).session.id);
        expect(pinnedSessions).toEqual(['d', 'b']);
    });

    it('hoists BOTH active and inactive pinned sessions into Pinned tier, in V2 order (pinned-tier option a)', () => {
        // Both active and inactive V2-pinned sessions hoist together to the
        // Pinned tier in V2.ungrouped order.
        // This is the option (a) tradeoff — pinned is pinned regardless of
        // activity state, so "Move to top" works for active sessions too.
        const baseData: BaseListItem<S>[] = [
            { type: 'active-sessions', sessions: [s('active-1'), s('active-pinned')] },
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('inactive-1') },
            { type: 'session', session: s('inactive-pinned') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['inactive-pinned', 'active-pinned'],
        };
        const result = combineGroupedListData(baseData, order, {});

        // Pinned tier at top with BOTH active-pinned and inactive-pinned,
        // ordered exactly per V2.ungrouped.
        expect(result.items[0]).toEqual({ type: 'header', title: 'Pinned' });
        expect((result.items[1] as any).session.id).toBe('inactive-pinned');
        expect((result.items[2] as any).session.id).toBe('active-pinned');

        // active-sessions now only has the un-pinned active row.
        const active = result.items.find(i => i.type === 'active-sessions');
        if (!active || active.type !== 'active-sessions') throw new Error('active-sessions missing');
        expect(active.sessions.map(x => x.id)).toEqual(['active-1']);

        // Today bucket only renders inactive-1 (inactive-pinned was hoisted).
        const todayHeader = result.items.findIndex(i => i.type === 'header' && (i as any).title === 'Today');
        expect(todayHeader).toBeGreaterThan(0);
        expect((result.items[todayHeader + 1] as any).session.id).toBe('inactive-1');
    });

    it('drops an active-sessions item if all its sessions moved into groups', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'active-sessions', sessions: [s('a'), s('b')] },
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('c') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['group-header', 'group-session', 'group-session', 'header', 'session']);
    });

    it('lifts all pinned inactive sessions into the Pinned header, emptying their bucket', () => {
        // Pre-cross-bucket behavior was "sort within the bucket." Now ALL
        // pinned inactive sessions hoist to the Pinned header at the top
        // and the original bucket's header gets dropped if it becomes empty.
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
            { type: 'session', session: s('c') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['c', 'a', 'b'],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['header', 'session', 'session', 'session']);
        const headers = result.items.filter(i => i.type === 'header').map(i => (i as any).title);
        expect(headers).toEqual(['Pinned']);
        const sessionIds = result.items
            .filter(i => i.type === 'session')
            .map(i => (i as any).session.id);
        expect(sessionIds).toEqual(['c', 'a', 'b']);
    });

    it('keeps unpinned sessions in original order under the original header (pinned ones hoist)', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
            { type: 'session', session: s('c') },
            { type: 'session', session: s('d') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['c'], // only c is pinned
        };
        const result = combineGroupedListData(baseData, order, {});

        // c hoists into Pinned; a, b, d stay under Today in original order.
        const types = result.items.map(i => i.type);
        expect(types).toEqual([
            'header',  // Pinned
            'session', // c
            'header',  // Today
            'session', 'session', 'session', // a, b, d
        ]);
        const headers = result.items.filter(i => i.type === 'header').map(i => (i as any).title);
        expect(headers).toEqual(['Pinned', 'Today']);
        const sessionIds = result.items
            .filter(i => i.type === 'session')
            .map(i => (i as any).session.id);
        expect(sessionIds).toEqual(['c', 'a', 'b', 'd']);
    });

    it('hoists pinned sessions across multiple date buckets into one Pinned header', () => {
        // Every pinned ID belongs to one top-of-list group regardless of its
        // date bucket; buckets emptied by the hoist do not render headers.
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
            { type: 'header', title: 'Yesterday' },
            { type: 'session', session: s('c') },
            { type: 'session', session: s('d') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['b', 'a', 'd', 'c'],
        };
        const result = combineGroupedListData(baseData, order, {});

        const types = result.items.map(i => i.type);
        expect(types).toEqual(['header', 'session', 'session', 'session', 'session']);
        const headers = result.items.filter(i => i.type === 'header').map(i => (i as any).title);
        expect(headers).toEqual(['Pinned']);
        const sessionIds = result.items
            .filter(i => i.type === 'session')
            .map(i => (i as any).session.id);
        // Today: b before a; Yesterday: d before c
        expect(sessionIds).toEqual(['b', 'a', 'd', 'c']);
    });

    it('V2.ungrouped only triggers reorder when no groups exist (still passes through correctly)', () => {
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'session', session: s('b') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['b', 'a'],
        };
        const result = combineGroupedListData(baseData, order, {});
        // hasGroups stays false (no group sections emitted) but reorder applies
        expect(result.hasGroups).toBe(false);
        const sessionIds = result.items
            .filter(i => i.type === 'session')
            .map(i => (i as any).session.id);
        expect(sessionIds).toEqual(['b', 'a']);
    });

    it('drops an orphan date header whose sessions all moved into groups', () => {
        // Better UX than rendering an empty section: if "Today" only had
        // session-a and a moved into a group, the "Today" header doesn't
        // render at all. Only sections with surviving sessions show up.
        const baseData: BaseListItem<S>[] = [
            { type: 'header', title: 'Today' },
            { type: 'session', session: s('a') },
            { type: 'header', title: 'Yesterday' },
            { type: 'session', session: s('b') },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };
        const result = combineGroupedListData(baseData, order, {});
        const types = result.items.map(i => i.type);
        expect(types).toEqual(['group-header', 'group-session', 'header', 'session']);
    });
});

describe('reorderUngrouped', () => {
    it('applies a new ordering of all ungrouped IDs', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['a', 'b', 'c'],
        };
        const result = reorderUngrouped(order, ['c', 'a', 'b']);
        expect(result.ungrouped).toEqual(['c', 'a', 'b']);
    });

    it('appends previously-ungrouped IDs that the caller omitted', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['a', 'b', 'c', 'd'],
        };
        const result = reorderUngrouped(order, ['c', 'a']);
        expect(result.ungrouped).toEqual(['c', 'a', 'b', 'd']);
    });

    it('silently drops unknown IDs', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['a', 'b'],
        };
        const result = reorderUngrouped(order, ['ghost', 'b', 'a']);
        expect(result.ungrouped).toEqual(['b', 'a']);
    });

    it('dedupes duplicate IDs in the caller list', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['a', 'b'],
        };
        const result = reorderUngrouped(order, ['a', 'a', 'b']);
        expect(result.ungrouped).toEqual(['a', 'b']);
    });

    it('does not touch groups', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['x', 'y'] }],
            ungrouped: ['a', 'b'],
        };
        const result = reorderUngrouped(order, ['b', 'a']);
        expect(result.groups).toEqual(order.groups);
    });
});

describe('reorderSessionsInGroup', () => {
    it('reorders sessions within a single group', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b', 'c'] }],
            ungrouped: [],
        };
        const result = reorderSessionsInGroup(order, 'g1', ['c', 'a', 'b']);
        expect(result.groups[0].sessionIds).toEqual(['c', 'a', 'b']);
    });

    it('returns input unchanged for unknown group ID', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };
        const result = reorderSessionsInGroup(order, 'ghost', ['x']);
        expect(result).toBe(order);
    });

    it('preserves group name + id while replacing sessionIds', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: [],
        };
        const result = reorderSessionsInGroup(order, 'g1', ['b', 'a']);
        expect(result.groups[0].id).toBe('g1');
        expect(result.groups[0].name).toBe('Work');
    });

    it('does not touch other groups or ungrouped', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: ['a', 'b'] },
                { id: 'g2', name: 'Personal', sessionIds: ['p1', 'p2'] },
            ],
            ungrouped: ['u'],
        };
        const result = reorderSessionsInGroup(order, 'g1', ['b', 'a']);
        expect(result.groups[1]).toEqual(order.groups[1]);
        expect(result.ungrouped).toEqual(['u']);
    });
});

describe('rebuildOrderFromDragSequence', () => {
    it('applies a within-group reorder', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b', 'c'] }],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'c', containerGroupId: 'g1' },
            { sessionId: 'a', containerGroupId: 'g1' },
            { sessionId: 'b', containerGroupId: 'g1' },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['c', 'a', 'b']);
    });

    it('moves a session across groups', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: ['a', 'b'] },
                { id: 'g2', name: 'Personal', sessionIds: ['c'] },
            ],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'a', containerGroupId: 'g1' },
            { sessionId: 'b', containerGroupId: 'g2' },
            { sessionId: 'c', containerGroupId: 'g2' },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.groups[1].sessionIds).toEqual(['b', 'c']);
    });

    it('moves a session out of a group into ungrouped', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'a', containerGroupId: 'g1' },
            { sessionId: 'b', containerGroupId: null },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.ungrouped).toEqual(['b']);
    });

    it('preserves groups not represented in the sequence', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: ['a', 'b'] },
                { id: 'g2', name: 'Personal', sessionIds: ['p1', 'p2'] },
            ],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'b', containerGroupId: 'g1' },
            { sessionId: 'a', containerGroupId: 'g1' },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['b', 'a']);
        expect(result.groups[1].sessionIds).toEqual(['p1', 'p2']);
    });

    it('preserves previously-ungrouped sessions not in the sequence', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['u1', 'u2'],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'a', containerGroupId: 'g1' },
        ]);
        expect(result.ungrouped).toEqual(['u1', 'u2']);
    });

    it('parks sessions referencing unknown group IDs into ungrouped', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'a', containerGroupId: 'g1' },
            { sessionId: 'b', containerGroupId: 'g-deleted' },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.ungrouped).toEqual(['b']);
    });

    it('skips duplicate session IDs in the sequence', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };
        const result = rebuildOrderFromDragSequence(order, [
            { sessionId: 'a', containerGroupId: 'g1' },
            { sessionId: 'a', containerGroupId: null },
        ]);
        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.ungrouped).toEqual([]);
    });
});
