import * as React from 'react';
import { useVisibleSessionListViewData } from './useVisibleSessionListViewData';
import { useSessionOrderV2 } from './useSessionOrderV2';
import type { Session } from '@/sync/storageTypes';
import {
    combineGroupedListData,
    GroupedListItem,
    GroupedListResult,
} from '@/sync/sessionOrder';

export type GroupedSessionListViewItem = GroupedListItem<Session>;
export type GroupedSessionListData = GroupedListResult<Session>;

/**
 * Subscribe to the session list view with V2 group ordering applied on top.
 *
 * When the V2 order has no groups, the underlying view (date-grouped via
 * `useVisibleSessionListViewData`) passes through unchanged — users who
 * haven't created a group see zero behavior change.
 *
 * When groups exist: group sections render at the top of the list, member
 * sessions are filtered out of their date buckets so they don't appear twice.
 * Collapsed state is owned by the caller via `collapsedGroups` (typically
 * `useSessionGroupCollapse`).
 *
 * Combination logic stays in the React-Native-free `sessionOrder.ts` module so
 * ordering remains deterministic and independently testable.
 */
export function useGroupedSessionListData(
    collapsedGroups: Record<string, boolean>
): GroupedSessionListData | null {
    const baseData = useVisibleSessionListViewData();
    const order = useSessionOrderV2();

    return React.useMemo(() => {
        if (!baseData) return null;
        return combineGroupedListData<Session>(baseData as any, order, collapsedGroups);
    }, [baseData, order, collapsedGroups]);
}
