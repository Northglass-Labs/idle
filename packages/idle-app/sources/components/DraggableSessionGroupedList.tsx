import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DraggableFlatList, { ScaleDecorator, RenderItemParams } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { SessionGroupedList } from './SessionGroupedList';
import { SessionGroupHeader } from './SessionGroupHeader';
import { Avatar } from './Avatar';
import { useReorderMode } from '@/hooks/useReorderMode';
import { useSessionOrderV2 } from '@/hooks/useSessionOrderV2';
import { useAllSessions } from '@/sync/storage';
import {
    getSessionName,
    getSessionAvatarId,
    useSessionStatus,
} from '@/utils/sessionUtils';
import { applySessionOrderV2, rebuildOrderFromDragSequence, SessionGroup } from '@/sync/sessionOrder';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';

/**
 * The actual sessions list shown on the home screen.
 *
 * Two modes:
 *  - **Normal:** delegates to `SessionGroupedList`, including group sections
 *    at the top when V2 groups exist.
 *  - **Reorder mode** (`useReorderMode`): renders a dedicated reorder view
 *    that lets the user drag group members within their group, or across
 *    groups, with a "Done" header banner to exit.
 *
 * Scope of the reorder view:
 *  - Only sessions inside groups are draggable. Ungrouped/date-bucketed
 *    sessions don't have drag affordance because `buildSessionListViewData`
 *    sorts them by `createdAt` and would clobber any explicit order. Once we
 *    teach the view-data builder to respect V2.ungrouped order, the reorder
 *    view can be extended to include the ungrouped section.
 *  - Group headers remain fixed; only their member sessions are draggable.
 *
 * Normal rendering remains delegated to `SessionGroupedList`; this component
 * adds only the transient reorder-mode branch.
 */
export function DraggableSessionGroupedList() {
    const reorderMode = useReorderMode((s) => s.enabled);
    if (!reorderMode) {
        return <SessionGroupedList />;
    }
    return <ReorderModeList />;
}

interface ReorderItem {
    type: 'session';
    key: string;
    session: Session;
    // `null` = ungrouped. Real group ID otherwise.
    containerGroupId: string | null;
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
}

interface ReorderHeaderItem {
    type: 'header';
    key: string;
    // Null for the synthetic "Ungrouped" header at the bottom. Real group
    // for normal group headers.
    group: SessionGroup | null;
    label: string;
    memberCount: number;
}

type ReorderRowItem = ReorderItem | ReorderHeaderItem;

const UNGROUPED_SENTINEL = '__ungrouped__';

function ReorderModeList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const order = useSessionOrderV2();
    const sessions = useAllSessions();
    const exit = useReorderMode((s) => s.exit);

    // Build the flat reorder list. Real groups come first, then a synthetic
    // "Ungrouped" header followed by all sessions not in any group (sorted by
    // V2.ungrouped order, with new sessions appended in createdAt order).
    const data = React.useMemo<ReorderRowItem[]>(() => {
        const grouped = applySessionOrderV2(sessions, order);
        const items: ReorderRowItem[] = [];
        for (const { group, sessions: groupSessions } of grouped.grouped) {
            items.push({
                type: 'header',
                key: `header-${group.id}`,
                group,
                label: group.name,
                memberCount: groupSessions.length,
            });
            groupSessions.forEach((session, idx) => {
                items.push({
                    type: 'session',
                    key: `session-${group.id}-${session.id}`,
                    session,
                    containerGroupId: group.id,
                    isFirstInGroup: idx === 0,
                    isLastInGroup: idx === groupSessions.length - 1,
                });
            });
        }
        if (grouped.ungrouped.length > 0) {
            items.push({
                type: 'header',
                key: `header-${UNGROUPED_SENTINEL}`,
                group: null,
                label: t('session.ungroupedHeader'),
                memberCount: grouped.ungrouped.length,
            });
            grouped.ungrouped.forEach((session, idx) => {
                items.push({
                    type: 'session',
                    key: `session-ungrouped-${session.id}`,
                    session,
                    containerGroupId: null,
                    isFirstInGroup: idx === 0,
                    isLastInGroup: idx === grouped.ungrouped.length - 1,
                });
            });
        }
        return items;
    }, [sessions, order]);

    const handleDragEnd = React.useCallback(({ data: newData }: { data: ReorderRowItem[] }) => {
        // Walk the new array, build a (sessionId, containerGroupId) sequence
        // by tracking which header the iteration is currently under. The
        // synthetic Ungrouped header has `group === null` so its sessions
        // emit containerGroupId=null, which `rebuildOrderFromDragSequence`
        // routes to V2.ungrouped.
        const sequence: Array<{ sessionId: string; containerGroupId: string | null }> = [];
        let currentGroupId: string | null = null;
        for (const item of newData) {
            if (item.type === 'header') {
                currentGroupId = item.group ? item.group.id : null;
            } else {
                sequence.push({ sessionId: item.session.id, containerGroupId: currentGroupId });
            }
        }
        const rebuilt = rebuildOrderFromDragSequence(order, sequence);
        sync.replaceSessionOrderV2(rebuilt);
    }, [order]);

    return (
        <GestureHandlerRootView style={styles.gestureRoot}>
            <View style={styles.container}>
                <View style={styles.contentContainer}>
                    <ReorderBanner onDone={exit} />
                    <DraggableFlatList
                        data={data}
                        keyExtractor={(item) => item.key}
                        onDragEnd={handleDragEnd}
                        renderItem={renderRow}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 128 }}
                    />
                </View>
            </View>
        </GestureHandlerRootView>
    );
}

function renderRow({ item, drag, isActive }: RenderItemParams<ReorderRowItem>) {
    if (item.type === 'header') {
        if (item.group === null) {
            return <UngroupedHeader memberCount={item.memberCount} label={item.label} />;
        }
        return (
            <View pointerEvents="box-none">
                <SessionGroupHeader
                    groupId={item.group.id}
                    name={item.group.name}
                    sessionCount={item.memberCount}
                    isExpanded={true}
                    onToggle={() => { /* always expanded in reorder mode */ }}
                />
            </View>
        );
    }
    return <ReorderSessionRow item={item} drag={drag} isActive={isActive} />;
}

function UngroupedHeader({ memberCount, label }: { memberCount: number; label: string }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.ungroupedHeader}>
            <Ionicons name="albums-outline" size={16} color={theme.colors.textSecondary} />
            <Text style={styles.ungroupedHeaderText}>{label}</Text>
            <Text style={styles.ungroupedHeaderCount}>{memberCount}</Text>
        </View>
    );
}

function ReorderBanner({ onDone }: { onDone: () => void }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={styles.banner}>
            <Ionicons name="information-circle-outline" size={16} color={theme.colors.textSecondary} />
            <Text style={styles.bannerText}>{t('session.reorderHint')}</Text>
            <Pressable onPress={onDone} style={styles.bannerButton} accessibilityRole="button">
                <Text style={styles.bannerButtonText}>{t('common.done')}</Text>
            </Pressable>
        </View>
    );
}

const ReorderSessionRow = React.memo(({ item, drag, isActive }: { item: ReorderItem; drag: () => void; isActive: boolean }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const sessionStatus = useSessionStatus(item.session);
    const sessionName = getSessionName(item.session);
    const avatarId = React.useMemo(() => getSessionAvatarId(item.session), [item.session]);

    return (
        <ScaleDecorator>
            <Pressable
                onLongPress={drag}
                disabled={isActive}
                style={[
                    styles.sessionItemContainer,
                    item.isFirstInGroup && styles.sessionItemContainerFirst,
                    item.isLastInGroup && styles.sessionItemContainerLast,
                    isActive && styles.sessionItemActive,
                ]}
            >
                <View style={styles.sessionItem}>
                    <View style={styles.dragHandle}>
                        <Ionicons name="reorder-three-outline" size={22} color={theme.colors.textSecondary} />
                    </View>
                    <Avatar
                        id={avatarId}
                        size={36}
                        monochrome={!sessionStatus.isConnected}
                        flavor={item.session.metadata?.flavor}
                    />
                    <Text style={styles.sessionTitle} numberOfLines={1}>
                        {sessionName}
                    </Text>
                </View>
            </Pressable>
        </ScaleDecorator>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    gestureRoot: {
        flex: 1,
    },
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    bannerText: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    bannerButton: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceSelected,
    },
    bannerButtonText: {
        fontSize: 13,
        color: theme.colors.text,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItemActive: {
        opacity: 0.95,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
    },
    sessionItem: {
        height: 60,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        gap: 12,
    },
    dragHandle: {
        width: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sessionTitle: {
        flex: 1,
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    ungroupedHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 8,
        backgroundColor: theme.colors.groupped.background,
    },
    ungroupedHeaderText: {
        flex: 1,
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    ungroupedHeaderCount: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
