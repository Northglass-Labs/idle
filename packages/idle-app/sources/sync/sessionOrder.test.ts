import { describe, it, expect } from 'vitest';
import {
    applySessionOrder,
    moveSessionToTop,
    pruneSessionOrder,
    migrateV1toV2,
    normalizeSessionOrder,
    createGroup,
    deleteGroup,
    renameGroup,
    moveSessionToGroup,
    applySessionOrderV2,
    SessionOrderV2,
} from './sessionOrder';

// Helper to create minimal session objects for testing
function session(id: string) {
    return { id };
}

describe('applySessionOrder', () => {
    it('returns sessions in custom order when all IDs match', () => {
        const sessions = [session('a'), session('b'), session('c')];
        const order = ['c', 'a', 'b'];

        const result = applySessionOrder(sessions, order);

        expect(result.map(s => s.id)).toEqual(['c', 'a', 'b']);
    });

    it('appends new sessions (not in order) at the end in original order', () => {
        const sessions = [session('a'), session('b'), session('c'), session('d')];
        const order = ['b', 'a'];

        const result = applySessionOrder(sessions, order);

        // b, a from custom order; then c, d in their original order
        expect(result.map(s => s.id)).toEqual(['b', 'a', 'c', 'd']);
    });

    it('silently prunes deleted sessions (IDs in order but not in list)', () => {
        const sessions = [session('a'), session('c')];
        const order = ['b', 'a', 'c']; // 'b' was deleted

        const result = applySessionOrder(sessions, order);

        expect(result.map(s => s.id)).toEqual(['a', 'c']);
    });

    it('returns sessions in original order when custom order is empty', () => {
        const sessions = [session('a'), session('b'), session('c')];
        const order: string[] = [];

        const result = applySessionOrder(sessions, order);

        expect(result.map(s => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when sessions is empty', () => {
        const sessions: { id: string }[] = [];
        const order = ['a', 'b', 'c'];

        const result = applySessionOrder(sessions, order);

        expect(result).toEqual([]);
    });

    it('handles partial overlap between order and sessions', () => {
        const sessions = [session('a'), session('b'), session('c'), session('d'), session('e')];
        const order = ['c', 'x', 'a', 'y']; // x, y are stale; b, d, e are new

        const result = applySessionOrder(sessions, order);

        // c, a from order; then b, d, e in original order
        expect(result.map(s => s.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
    });

    it('preserves extra properties on session objects', () => {
        const sessions = [
            { id: 'a', name: 'Session A', updatedAt: 100 },
            { id: 'b', name: 'Session B', updatedAt: 200 },
        ];
        const order = ['b', 'a'];

        const result = applySessionOrder(sessions, order);

        expect(result[0]).toEqual({ id: 'b', name: 'Session B', updatedAt: 200 });
        expect(result[1]).toEqual({ id: 'a', name: 'Session A', updatedAt: 100 });
    });

    it('handles duplicate IDs in custom order gracefully', () => {
        const sessions = [session('a'), session('b'), session('c')];
        const order = ['b', 'a', 'b']; // 'b' appears twice

        const result = applySessionOrder(sessions, order);

        // First occurrence of 'b' wins, second is skipped (already consumed)
        expect(result.map(s => s.id)).toEqual(['b', 'a', 'c']);
    });

    it('handles single session', () => {
        const sessions = [session('a')];
        const order = ['a'];

        const result = applySessionOrder(sessions, order);

        expect(result.map(s => s.id)).toEqual(['a']);
    });
});

describe('moveSessionToTop', () => {
    it('moves an existing session to the top', () => {
        const order = ['a', 'b', 'c'];

        const result = moveSessionToTop(order, 'c');

        expect(result).toEqual(['c', 'a', 'b']);
    });

    it('prepends a session not in the current order', () => {
        const order = ['a', 'b'];

        const result = moveSessionToTop(order, 'c');

        expect(result).toEqual(['c', 'a', 'b']);
    });

    it('is a no-op when session is already at the top', () => {
        const order = ['a', 'b', 'c'];

        const result = moveSessionToTop(order, 'a');

        expect(result).toEqual(['a', 'b', 'c']);
    });

    it('works with empty order', () => {
        const order: string[] = [];

        const result = moveSessionToTop(order, 'a');

        expect(result).toEqual(['a']);
    });

    it('does not mutate the original array', () => {
        const order = ['a', 'b', 'c'];
        const original = [...order];

        moveSessionToTop(order, 'c');

        expect(order).toEqual(original);
    });
});

describe('pruneSessionOrder', () => {
    it('removes IDs not in the valid set', () => {
        const order = ['a', 'b', 'c', 'd'];
        const valid = new Set(['a', 'c']);

        const result = pruneSessionOrder(order, valid);

        expect(result).toEqual(['a', 'c']);
    });

    it('returns empty array when no IDs are valid', () => {
        const order = ['a', 'b', 'c'];
        const valid = new Set<string>();

        const result = pruneSessionOrder(order, valid);

        expect(result).toEqual([]);
    });

    it('returns all IDs when all are valid', () => {
        const order = ['a', 'b', 'c'];
        const valid = new Set(['a', 'b', 'c']);

        const result = pruneSessionOrder(order, valid);

        expect(result).toEqual(['a', 'b', 'c']);
    });

    it('preserves order of remaining IDs', () => {
        const order = ['d', 'b', 'e', 'a', 'c'];
        const valid = new Set(['a', 'c', 'e']);

        const result = pruneSessionOrder(order, valid);

        expect(result).toEqual(['e', 'a', 'c']);
    });

    it('handles empty order', () => {
        const order: string[] = [];
        const valid = new Set(['a', 'b']);

        const result = pruneSessionOrder(order, valid);

        expect(result).toEqual([]);
    });

    it('does not mutate the original array', () => {
        const order = ['a', 'b', 'c'];
        const original = [...order];

        pruneSessionOrder(order, new Set(['a']));

        expect(order).toEqual(original);
    });
});

// === V2: Session Groups Tests ===

function emptyV2(): SessionOrderV2 {
    return { version: 2, groups: [], ungrouped: [] };
}

describe('migrateV1toV2', () => {
    it('converts a v1 array to v2 with all sessions ungrouped', () => {
        const result = migrateV1toV2(['a', 'b', 'c']);

        expect(result).toEqual({
            version: 2,
            groups: [],
            ungrouped: ['a', 'b', 'c'],
        });
    });

    it('converts an empty v1 array to empty v2', () => {
        const result = migrateV1toV2([]);

        expect(result).toEqual({ version: 2, groups: [], ungrouped: [] });
    });

    it('does not mutate the original array', () => {
        const v1 = ['a', 'b'];
        const original = [...v1];

        migrateV1toV2(v1);

        expect(v1).toEqual(original);
    });
});

describe('normalizeSessionOrder', () => {
    it('normalizes a v1 array to v2', () => {
        const result = normalizeSessionOrder(['x', 'y']);

        expect(result.version).toBe(2);
        expect(result.ungrouped).toEqual(['x', 'y']);
        expect(result.groups).toEqual([]);
    });

    it('returns v2 data as-is when version is 2', () => {
        const v2: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = normalizeSessionOrder(v2);

        expect(result).toEqual(v2);
    });

    it('returns empty v2 for null input', () => {
        const result = normalizeSessionOrder(null);

        expect(result).toEqual({ version: 2, groups: [], ungrouped: [] });
    });

    it('returns empty v2 for undefined input', () => {
        const result = normalizeSessionOrder(undefined);

        expect(result).toEqual({ version: 2, groups: [], ungrouped: [] });
    });

    it('returns empty v2 for non-object/non-array input', () => {
        expect(normalizeSessionOrder(42)).toEqual({ version: 2, groups: [], ungrouped: [] });
        expect(normalizeSessionOrder('hello')).toEqual({ version: 2, groups: [], ungrouped: [] });
        expect(normalizeSessionOrder(true)).toEqual({ version: 2, groups: [], ungrouped: [] });
    });

    it('returns empty v2 for object with wrong version', () => {
        const result = normalizeSessionOrder({ version: 99, groups: [], ungrouped: [] });

        expect(result).toEqual({ version: 2, groups: [], ungrouped: [] });
    });

    it('returns empty v2 for object without version field', () => {
        const result = normalizeSessionOrder({ groups: [], ungrouped: [] });

        expect(result).toEqual({ version: 2, groups: [], ungrouped: [] });
    });
});

describe('createGroup', () => {
    it('adds a new empty group', () => {
        const order = emptyV2();

        const result = createGroup(order, 'g1', 'Work');

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]).toEqual({ id: 'g1', name: 'Work', sessionIds: [] });
    });

    it('appends group to existing groups', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = createGroup(order, 'g2', 'Personal');

        expect(result.groups).toHaveLength(2);
        expect(result.groups[0].id).toBe('g1');
        expect(result.groups[1]).toEqual({ id: 'g2', name: 'Personal', sessionIds: [] });
    });

    it('does not mutate the original order', () => {
        const order = emptyV2();
        const originalGroups = [...order.groups];

        createGroup(order, 'g1', 'Test');

        expect(order.groups).toEqual(originalGroups);
    });

    it('preserves ungrouped sessions', () => {
        const order: SessionOrderV2 = { version: 2, groups: [], ungrouped: ['x', 'y'] };

        const result = createGroup(order, 'g1', 'New');

        expect(result.ungrouped).toEqual(['x', 'y']);
    });
});

describe('deleteGroup', () => {
    it('removes the group and moves its sessions to ungrouped', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: ['c'],
        };

        const result = deleteGroup(order, 'g1');

        expect(result.groups).toHaveLength(0);
        // Deleted group's sessions are prepended to ungrouped
        expect(result.ungrouped).toEqual(['a', 'b', 'c']);
    });

    it('returns order unchanged if group does not exist', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = deleteGroup(order, 'nonexistent');

        expect(result).toBe(order); // Same reference — no change
    });

    it('handles deleting a group with no sessions', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Empty', sessionIds: [] }],
            ungrouped: ['a'],
        };

        const result = deleteGroup(order, 'g1');

        expect(result.groups).toHaveLength(0);
        expect(result.ungrouped).toEqual(['a']);
    });

    it('only deletes the targeted group, leaving others intact', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: ['a'] },
                { id: 'g2', name: 'Personal', sessionIds: ['b'] },
            ],
            ungrouped: ['c'],
        };

        const result = deleteGroup(order, 'g1');

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].id).toBe('g2');
        expect(result.ungrouped).toEqual(['a', 'c']);
    });
});

describe('renameGroup', () => {
    it('renames the specified group', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Old Name', sessionIds: ['a'] }],
            ungrouped: [],
        };

        const result = renameGroup(order, 'g1', 'New Name');

        expect(result.groups[0].name).toBe('New Name');
        expect(result.groups[0].sessionIds).toEqual(['a']);
    });

    it('does not affect other groups', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: [] },
                { id: 'g2', name: 'Personal', sessionIds: [] },
            ],
            ungrouped: [],
        };

        const result = renameGroup(order, 'g2', 'Home');

        expect(result.groups[0].name).toBe('Work');
        expect(result.groups[1].name).toBe('Home');
    });

    it('returns unchanged order if group not found', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: [] }],
            ungrouped: [],
        };

        const result = renameGroup(order, 'nonexistent', 'Whatever');

        // Groups array is mapped (new reference) but content is identical
        expect(result.groups[0].name).toBe('Work');
    });
});

describe('moveSessionToGroup', () => {
    it('moves a session from ungrouped to a group', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: [] }],
            ungrouped: ['a', 'b'],
        };

        const result = moveSessionToGroup(order, 'a', 'g1');

        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.ungrouped).toEqual(['b']);
    });

    it('moves a session from one group to another', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Work', sessionIds: ['a', 'b'] },
                { id: 'g2', name: 'Personal', sessionIds: ['c'] },
            ],
            ungrouped: [],
        };

        const result = moveSessionToGroup(order, 'b', 'g2');

        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.groups[1].sessionIds).toEqual(['b', 'c']);
    });

    it('moves a session from a group to ungrouped (null target)', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'b'] }],
            ungrouped: ['c'],
        };

        const result = moveSessionToGroup(order, 'a', null);

        expect(result.groups[0].sessionIds).toEqual(['b']);
        expect(result.ungrouped).toEqual(['a', 'c']);
    });

    it('prepends session to target group (top position)', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['x', 'y'] }],
            ungrouped: ['a'],
        };

        const result = moveSessionToGroup(order, 'a', 'g1');

        expect(result.groups[0].sessionIds).toEqual(['a', 'x', 'y']);
    });

    it('prepends session to ungrouped when target is null', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b', 'c'],
        };

        const result = moveSessionToGroup(order, 'a', null);

        expect(result.ungrouped).toEqual(['a', 'b', 'c']);
    });

    it('handles moving to a nonexistent group (session just removed)', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = moveSessionToGroup(order, 'b', 'nonexistent');

        // Session removed from ungrouped, target doesn't exist so it's just gone
        expect(result.groups[0].sessionIds).toEqual(['a']);
        expect(result.ungrouped).toEqual([]);
    });

    it('handles session not present anywhere (new session to group)', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: [],
        };

        const result = moveSessionToGroup(order, 'new-session', 'g1');

        expect(result.groups[0].sessionIds).toEqual(['new-session', 'a']);
    });

    it('handles session not present anywhere (new session to ungrouped)', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [],
            ungrouped: ['a'],
        };

        const result = moveSessionToGroup(order, 'new-session', null);

        expect(result.ungrouped).toEqual(['new-session', 'a']);
    });

    it('does not mutate the original order', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };
        const originalGroupSessions = [...order.groups[0].sessionIds];
        const originalUngrouped = [...order.ungrouped];

        moveSessionToGroup(order, 'b', 'g1');

        expect(order.groups[0].sessionIds).toEqual(originalGroupSessions);
        expect(order.ungrouped).toEqual(originalUngrouped);
    });
});

describe('applySessionOrderV2', () => {
    it('sorts sessions into groups and ungrouped', () => {
        const sessions = [session('a'), session('b'), session('c'), session('d')];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['b', 'd'] }],
            ungrouped: ['a', 'c'],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped).toHaveLength(1);
        expect(result.grouped[0].group.name).toBe('Work');
        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['b', 'd']);
        expect(result.ungrouped.map(s => s.id)).toEqual(['a', 'c']);
    });

    it('puts new sessions (not in any list) at the end of ungrouped', () => {
        const sessions = [session('a'), session('b'), session('new1'), session('new2')];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['a']);
        expect(result.ungrouped.map(s => s.id)).toEqual(['b', 'new1', 'new2']);
    });

    it('silently skips stale IDs (deleted sessions)', () => {
        const sessions = [session('a')];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a', 'deleted'] }],
            ungrouped: ['also-deleted'],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['a']);
        expect(result.ungrouped).toEqual([]);
    });

    it('handles empty sessions list', () => {
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['b'],
        };

        const result = applySessionOrderV2([], order);

        expect(result.grouped[0].sessions).toEqual([]);
        expect(result.ungrouped).toEqual([]);
    });

    it('handles empty order (all sessions go to ungrouped)', () => {
        const sessions = [session('a'), session('b')];
        const order = emptyV2();

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped).toEqual([]);
        expect(result.ungrouped.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('preserves group order from the order structure', () => {
        const sessions = [session('a'), session('b'), session('c')];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'First', sessionIds: ['c'] },
                { id: 'g2', name: 'Second', sessionIds: ['a'] },
            ],
            ungrouped: ['b'],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped[0].group.name).toBe('First');
        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['c']);
        expect(result.grouped[1].group.name).toBe('Second');
        expect(result.grouped[1].sessions.map(s => s.id)).toEqual(['a']);
    });

    it('prevents duplicate consumption — session only appears once', () => {
        const sessions = [session('a')];
        // Session 'a' referenced in both a group and ungrouped
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['a'] }],
            ungrouped: ['a'],
        };

        const result = applySessionOrderV2(sessions, order);

        // 'a' consumed by group first, skipped in ungrouped
        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['a']);
        expect(result.ungrouped).toEqual([]);
    });

    it('preserves extra properties on session objects', () => {
        const sessions = [
            { id: 'a', name: 'Session A', updatedAt: 100 },
            { id: 'b', name: 'Session B', updatedAt: 200 },
        ];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [{ id: 'g1', name: 'Work', sessionIds: ['b'] }],
            ungrouped: ['a'],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped[0].sessions[0]).toEqual({ id: 'b', name: 'Session B', updatedAt: 200 });
        expect(result.ungrouped[0]).toEqual({ id: 'a', name: 'Session A', updatedAt: 100 });
    });

    it('handles multiple groups with overlapping references', () => {
        const sessions = [session('a'), session('b')];
        // Session 'a' referenced in two groups — first group wins
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'First', sessionIds: ['a'] },
                { id: 'g2', name: 'Second', sessionIds: ['a', 'b'] },
            ],
            ungrouped: [],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped[0].sessions.map(s => s.id)).toEqual(['a']);
        // 'a' already consumed, only 'b' appears in second group
        expect(result.grouped[1].sessions.map(s => s.id)).toEqual(['b']);
    });

    it('includes empty groups in result (group with no matching sessions)', () => {
        const sessions = [session('a')];
        const order: SessionOrderV2 = {
            version: 2,
            groups: [
                { id: 'g1', name: 'Empty', sessionIds: [] },
                { id: 'g2', name: 'Has One', sessionIds: ['a'] },
            ],
            ungrouped: [],
        };

        const result = applySessionOrderV2(sessions, order);

        expect(result.grouped).toHaveLength(2);
        expect(result.grouped[0].sessions).toEqual([]);
        expect(result.grouped[1].sessions.map(s => s.id)).toEqual(['a']);
    });
});
