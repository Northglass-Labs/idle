import { describe, expect, it } from 'vitest';
import { itemShouldExpand, createItemExpandState, type ItemExpandState } from './itemExpandState';

describe('createItemExpandState', () => {
    it('initializes expanded=false by default', () => {
        const state = createItemExpandState();
        expect(state.expanded).toBe(false);
    });

    it('initializes expanded=true when defaultExpanded=true', () => {
        const state = createItemExpandState({ defaultExpanded: true });
        expect(state.expanded).toBe(true);
    });

    it('initializes expanded=false when defaultExpanded=false (explicit)', () => {
        const state = createItemExpandState({ defaultExpanded: false });
        expect(state.expanded).toBe(false);
    });
});

describe('itemShouldExpand', () => {
    it('returns true when longDescription is non-empty and item has been toggled open', () => {
        const state: ItemExpandState = { expanded: true };
        expect(itemShouldExpand(state, 'Some long description text')).toBe(true);
    });

    it('returns false when longDescription is empty even if toggled open', () => {
        const state: ItemExpandState = { expanded: true };
        expect(itemShouldExpand(state, '')).toBe(false);
    });

    it('returns false when longDescription is undefined', () => {
        const state: ItemExpandState = { expanded: true };
        expect(itemShouldExpand(state, undefined)).toBe(false);
    });

    it('returns false when not toggled open even with content', () => {
        const state: ItemExpandState = { expanded: false };
        expect(itemShouldExpand(state, 'content')).toBe(false);
    });

    it('returns false when state is null (item not yet rendered)', () => {
        expect(itemShouldExpand(null, 'content')).toBe(false);
    });

    it('returns false when both state is null and description is missing', () => {
        expect(itemShouldExpand(null, undefined)).toBe(false);
    });
});
