import React from 'react';
import { View, Pressable, FlatList, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { Text } from '@/components/StyledText';
import { usePathname } from 'expo-router';
import { SessionListViewItem, buildSessionRowData } from '@/sync/storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
    useSessionStatus,
    getSessionSubtitle,
    getSessionAvatarId,
    formatLastSeen,
} from '@/utils/sessionUtils';
import { getSessionLastSeenTimestamp } from '@/utils/sessionLastSeen';
import { useSessionDisplayName } from '@/hooks/useSessionDisplayName';
import { Avatar } from './Avatar';
import { ActiveSessionsGroup } from './ActiveSessionsGroup';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting, useLocalSetting } from '@/sync/storage';
import { useGroupedSessionListData, GroupedSessionListViewItem } from '@/hooks/useGroupedSessionListData';
import { useSessionGroupCollapse } from '@/hooks/useSessionGroupCollapse';
import { Typography } from '@/constants/Typography';
import { Session } from '@/sync/storageTypes';
import { StatusDot } from './StatusDot';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { requestReview } from '@/utils/requestReview';
import { UpdateBanner } from './UpdateBanner';
import { layout } from './layout';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { SessionGroupHeader } from './SessionGroupHeader';
import { hapticsLight } from './haptics';

/**
 * Parallel renderer to SessionsList that adds V2 group support on top.
 *
 * Behavior:
 *  - When the user has zero session groups → renders the same date-grouped
 *    list SessionsList would, with identical visuals for users who never
 *    create a group.
 *  - When groups exist → group sections render at the top of the list
 *    (collapsible via SessionGroupHeader tap). Sessions that belong to a
 *    group are removed from their date bucket so they don't appear twice.
 *
 * Group composition stays isolated from row rendering: this component applies
 * group ordering and delegates row behavior to the standard session surfaces.
 */

const stylesheet = StyleSheet.create((theme) => ({
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
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
    },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    sessionItemSingle: {
        borderRadius: 12,
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
    sessionItemContainerSingle: {
        borderRadius: 12,
        marginBottom: 12,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    sessionTimestamp: {
        fontSize: 12,
        color: theme.colors.textSecondary ?? '#8E8E93',
        marginLeft: 8,
        flexShrink: 0,
        ...Typography.default(),
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
}));

export function SessionGroupedList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const { collapsed, toggleGroup } = useSessionGroupCollapse();
    const data = useGroupedSessionListData(collapsed);
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const compactSessionView = useSetting('compactSessionView');
    const selectable = isTablet;

    const items = data?.items ?? null;

    const dataWithSelected = React.useMemo(() => {
        if (!items) return items;
        if (!selectable) return items;
        return items.map(item => {
            if (item.type === 'session' || item.type === 'group-session') {
                const sessionId = item.type === 'session' ? item.session.id : item.session.id;
                return {
                    ...item,
                    selected: pathname.startsWith(`/session/${sessionId}`),
                };
            }
            return item;
        });
    }, [items, pathname, selectable]);

    React.useEffect(() => {
        const controller = new AbortController();
        if (pathname === '/' && items && items.length > 0) {
            void requestReview({ signal: controller.signal });
        }
        return () => controller.abort();
    }, [items && items.length > 0, pathname]);

    if (!items) {
        return <View style={styles.container} />;
    }

    const keyExtractor = (
        item: (GroupedSessionListViewItem & { selected?: boolean }),
        index: number
    ) => {
        switch (item.type) {
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'session': return `session-${item.session.id}`;
            case 'group-header': return `group-header-${item.group.id}`;
            case 'group-session': return `group-session-${item.group.id}-${item.session.id}`;
        }
    };

    const renderItem = ({
        item,
        index,
    }: {
        item: (GroupedSessionListViewItem & { selected?: boolean });
        index: number;
    }) => {
        const list = dataWithSelected as Array<GroupedSessionListViewItem & { selected?: boolean }> | null;

        switch (item.type) {
            case 'header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>{item.title}</Text>
                    </View>
                );

            case 'active-sessions': {
                let selectedId: string | undefined;
                if (isTablet && pathname.startsWith('/session/')) {
                    selectedId = pathname.split('/')[2];
                }
                const ActiveComponent = compactSessionView ? ActiveSessionsGroupCompact : ActiveSessionsGroup;
                // Grouped view keeps full Session[] in its own view model; both list
                // variants now consume the lightweight SessionRowData projection.
                // (No unread set here — the grouped view has no unread model.)
                return <ActiveComponent sessions={item.sessions.map((s) => buildSessionRowData(s))} selectedSessionId={selectedId} />;
            }

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>{item.displayPath}</Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

            case 'session': {
                const prevItem = index > 0 && list ? list[index - 1] : null;
                const nextItem = list && index < list.length - 1 ? list[index + 1] : null;
                const isFirst = prevItem?.type === 'header';
                const isLast =
                    nextItem == null ||
                    nextItem?.type === 'header' ||
                    nextItem?.type === 'active-sessions' ||
                    nextItem?.type === 'group-header';
                const isSingle = isFirst && isLast;
                return (
                    <SessionItem
                        session={item.session}
                        selected={item.selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                    />
                );
            }

            case 'group-header':
                return (
                    <SessionGroupHeader
                        groupId={item.group.id}
                        name={item.group.name}
                        sessionCount={item.sessionCount}
                        isExpanded={item.isExpanded}
                        onToggle={() => toggleGroup(item.group.id)}
                    />
                );

            case 'group-session': {
                const isFirst = item.isFirstInGroup;
                const isLast = item.isLastInGroup;
                const isSingle = isFirst && isLast;
                return (
                    <SessionItem
                        session={item.session}
                        selected={item.selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                    />
                );
            }
        }
    };

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    testID="sessions-list"
                    data={dataWithSelected ?? []}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{
                        paddingBottom: safeArea.bottom + 128,
                        maxWidth: layout.maxWidth,
                    }}
                    ListHeaderComponent={UpdateBanner}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                />
            </View>
        </View>
    );
}

// Kept local because this grouped renderer owns its row actions and selection
// state as one unit.
const SessionItem = React.memo(({
    session,
    selected,
    isFirst,
    isLast,
    isSingle,
}: {
    session: Session;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
}) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = useSessionDisplayName(session);
    const sessionSubtitle = getSessionSubtitle(session);
    const navigateToSession = useNavigateToSession();
    const showTimestamps = useLocalSetting('showMessageTimestamps');
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const avatarId = React.useMemo(() => getSessionAvatarId(session), [session]);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const openActionsAt = React.useCallback((pageX: number, pageY: number) => {
        hapticsLight();
        setActionsAnchor({ type: 'point', x: pageX, y: pageY });
    }, []);

    // Use react-native-gesture-handler's LongPress instead of Pressable's
    // onLongPress. Pressable's iOS implementation competes with the parent
    // FlatList's scroll handler — tiny finger movement during the hold
    // cancels the long-press timer before it fires. Gesture-handler lives
    // in the same gesture stack as the FlatList scroll gesture and resolves
    // the contention deterministically, fixing long-press cancellation on iOS.
    //
    // 350ms minDuration matches what we had before (well above the tap
    // threshold). onStart fires when the timer succeeds; runOnJS hops back
    // to the JS thread because gesture callbacks run on the UI thread.
    const longPressGesture = React.useMemo(() =>
        Gesture.LongPress()
            .minDuration(350)
            .onStart((e) => {
                runOnJS(openActionsAt)(e.absoluteX, e.absoluteY);
            }),
        [openActionsAt]
    );

    const webMenuProps = Platform.OS === 'web' ? ({ onContextMenu: handleContextMenu } as any) : {};

    return (
        <View
            style={[
                styles.sessionItemContainer,
                isSingle
                    ? styles.sessionItemContainerSingle
                    : isFirst
                        ? styles.sessionItemContainerFirst
                        : isLast
                            ? styles.sessionItemContainerLast
                            : {},
            ]}
        >
            <GestureDetector gesture={longPressGesture}>
            <Pressable
                testID="session-row"
                style={[
                    styles.sessionItem,
                    selected && styles.sessionItemSelected,
                    isSingle
                        ? styles.sessionItemSingle
                        : isFirst
                            ? styles.sessionItemFirst
                            : isLast
                                ? styles.sessionItemLast
                                : {},
                ]}
                onPress={handlePress}
                {...webMenuProps}
            >
                <View style={styles.avatarContainer}>
                    <Avatar
                        id={avatarId}
                        size={48}
                        monochrome={!sessionStatus.isConnected}
                        flavor={session.metadata?.flavor}
                    />
                    {session.draft && (
                        <View style={styles.draftIconContainer}>
                            <Ionicons name="create-outline" size={12} style={styles.draftIconOverlay} />
                        </View>
                    )}
                </View>
                <View style={styles.sessionContent}>
                    <View style={styles.sessionTitleRow}>
                        <Text
                            style={[
                                styles.sessionTitle,
                                sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected,
                            ]}
                            numberOfLines={1}
                        >
                            {sessionName}
                        </Text>
                        {showTimestamps && getSessionLastSeenTimestamp(session) ? (
                            <Text style={styles.sessionTimestamp} numberOfLines={1}>
                                {formatLastSeen(getSessionLastSeenTimestamp(session), false)}
                            </Text>
                        ) : null}
                    </View>
                    <Text style={styles.sessionSubtitle} numberOfLines={1}>
                        {sessionSubtitle}
                    </Text>
                    <View style={styles.statusRow}>
                        <View style={styles.statusDotContainer}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                        </View>
                        <Text style={[styles.statusText, { color: sessionStatus.statusColor }]}>
                            {sessionStatus.statusText}
                        </Text>
                    </View>
                </View>
            </Pressable>
            </GestureDetector>
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                session={session}
                visible={!!actionsAnchor}
            />
        </View>
    );
});
