/**
 * Pure helper for Item row expand/collapse state.
 *
 * Extracted from Item.tsx so the logic is vitest-runnable without RN deps.
 * The Item component holds the state via React.useState; this file provides
 * the gating logic ("should we render the expanded content?") that the
 * component reads on every render.
 *
 * Used by:
 * - components/Item.tsx for the longDescription expand/collapse UX
 * - Lab feature rows (tap-to-expand for full feature detail)
 * - any other settings sub-screen that wants a "more info" disclosure
 */

export interface ItemExpandState {
    expanded: boolean;
}

export interface ItemExpandStateOptions {
    defaultExpanded?: boolean;
}

export function createItemExpandState(options?: ItemExpandStateOptions): ItemExpandState {
    return {
        expanded: options?.defaultExpanded ?? false,
    };
}

/**
 * Returns true only when there's content to expand AND the user has opened it.
 * Defensive against null state (item not yet rendered) and missing/empty
 * longDescription (no point in animating in an empty box).
 */
export function itemShouldExpand(state: ItemExpandState | null, longDescription: string | undefined): boolean {
    if (state === null) return false;
    if (!state.expanded) return false;
    if (!longDescription || longDescription.length === 0) return false;
    return true;
}
