import * as React from 'react';
import { Pressable, Modal as RNModal, Platform, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Typography } from '@/constants/Typography';
import { useSessionQuickActions, SessionActionItem } from '@/hooks/useSessionQuickActions';
import { useSessionOrderV2 } from '@/hooks/useSessionOrderV2';
import { useReorderMode } from '@/hooks/useReorderMode';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { storage, useLocalSetting } from '@/sync/storage';
import { getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { t } from '@/text';

export type SessionActionsAnchor =
    | {
        type: 'point';
        x: number;
        y: number;
    }
    | {
        type: 'rect';
        x: number;
        y: number;
        width: number;
        height: number;
    };

interface SessionActionsPopoverProps {
    anchor: SessionActionsAnchor | null;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onClose: () => void;
    session: Session;
    visible: boolean;
}

const WEB_MENU_WIDTH = 232;
const WEB_MENU_ITEM_HEIGHT = 48;
const WEB_MENU_MARGIN = 12;

const stylesheet = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.12)',
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 18,
        shadowOffset: {
            width: 0,
            height: 8,
        },
        elevation: 10,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 10,
        marginBottom: 8,
        alignSelf: 'center',
    },
    menuItem: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemDivider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    menuItemLabel: {
        flex: 1,
        fontSize: 15,
        lineHeight: 20,
        ...Typography.default(),
    },
    nativeContainer: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    nativeSheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        overflow: 'hidden',
    },
    webContainer: {
        flex: 1,
    },
    webMenu: {
        position: 'absolute',
        width: WEB_MENU_WIDTH,
    },
}));

export function SessionActionsPopover({
    anchor,
    onAfterArchive,
    onAfterDelete,
    onClose,
    session,
    visible,
}: SessionActionsPopoverProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();
    // Shared session actions come from one hook so row and popover behavior stay
    // consistent.
    const { actionItems: baseActionItems } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    const order = useSessionOrderV2();
    const enterReorder = useReorderMode((s) => s.enter);
    const currentGroup = React.useMemo(() => {
        return order.groups.find(g => g.sessionIds.includes(session.id)) ?? null;
    }, [order, session.id]);

    const customNames = useLocalSetting('customSessionNames');
    const renameSession = React.useCallback(async () => {
        const existingOverride = customNames?.[session.id];
        const fallbackName = getSessionName(session);
        const newName = await Modal.prompt(
            t('session.renameTitle'),
            t('session.renameMessage'),
            {
                placeholder: t('session.renamePlaceholder'),
                defaultValue: existingOverride || (fallbackName === t('status.unknown') ? '' : fallbackName),
            },
        );
        if (newName === null) return; // user cancelled
        const trimmed = newName.trim();
        // Empty string → clear the override (revert to canonical name).
        const updated = { ...(customNames ?? {}) };
        if (trimmed.length === 0) {
            delete updated[session.id];
        } else {
            updated[session.id] = trimmed;
        }
        storage.getState().applyLocalSettings({ customSessionNames: updated });
    }, [customNames, session]);

    const showMoveToGroupPicker = React.useCallback(() => {
        const buttons = order.groups.map(g => ({
            text: g.name,
            onPress: () => sync.moveSessionToGroup(session.id, g.id),
        }));
        buttons.push({
            text: t('session.newGroup'),
            onPress: async () => {
                const name = await Modal.prompt(t('session.newGroupTitle'), undefined, {
                    placeholder: t('session.newGroupPlaceholder'),
                });
                if (!name || !name.trim()) return;
                const groupId = await sync.createSessionGroup(name.trim());
                if (groupId) {
                    sync.moveSessionToGroup(session.id, groupId);
                }
            },
        });
        Modal.alert(t('session.moveToGroup'), undefined, [
            ...buttons,
            { text: t('common.cancel'), style: 'cancel', onPress: () => {} },
        ]);
    }, [order, session.id]);

    const actions = React.useMemo<SessionActionItem[]>(() => {
        // Ordering, grouping, and rename actions are inserted after details.
        // They remain available with zero groups because the picker can create
        // the first group inline.
        const idleItems: SessionActionItem[] = [
            {
                id: 'rename',
                icon: 'pencil-outline',
                label: t('session.rename'),
                onPress: renameSession,
            },
            {
                id: 'move-to-top',
                icon: 'arrow-up-outline',
                label: t('session.moveToTop'),
                onPress: () => sync.moveSessionToTop(session.id),
            },
            {
                id: 'move-to-group',
                icon: 'folder-outline',
                label: currentGroup
                    ? t('session.moveToGroupFrom', { name: currentGroup.name })
                    : t('session.moveToGroup'),
                onPress: showMoveToGroupPicker,
            },
        ];
        if (currentGroup) {
            idleItems.push({
                id: 'remove-from-group',
                icon: 'remove-circle-outline',
                label: t('session.removeFromGroup'),
                onPress: () => sync.moveSessionToGroup(session.id, null),
            });
        }
        idleItems.push({
            id: 'rearrange-sessions',
            icon: 'reorder-three-outline',
            label: t('session.rearrangeSessions'),
            onPress: enterReorder,
        });

        const items = [...baseActionItems];
        const detailsIndex = items.findIndex(item => item.id === 'details');
        items.splice(detailsIndex + 1, 0, ...idleItems);
        return items;
    }, [
        baseActionItems,
        currentGroup,
        enterReorder,
        renameSession,
        session.id,
        showMoveToGroupPicker,
    ]);

    const position = React.useMemo(() => {
        if (!anchor) {
            return null;
        }

        const estimatedHeight = actions.length * WEB_MENU_ITEM_HEIGHT;
        const leftBase = anchor.type === 'point'
            ? anchor.x
            : anchor.x + anchor.width - WEB_MENU_WIDTH;

        let topBase = anchor.type === 'point'
            ? anchor.y
            : anchor.y + anchor.height + 8;

        if (anchor.type === 'rect' && topBase + estimatedHeight > windowHeight - WEB_MENU_MARGIN) {
            topBase = anchor.y - estimatedHeight - 8;
        }

        return {
            left: Math.max(WEB_MENU_MARGIN, Math.min(windowWidth - WEB_MENU_WIDTH - WEB_MENU_MARGIN, leftBase)),
            top: Math.max(WEB_MENU_MARGIN, Math.min(windowHeight - estimatedHeight - WEB_MENU_MARGIN, topBase)),
        };
    }, [actions.length, anchor, windowHeight, windowWidth]);

    const handleActionPress = React.useCallback((action: SessionActionItem) => {
        onClose();
        action.onPress();
    }, [onClose]);

    if (!visible || !anchor) {
        return null;
    }

    const content = (
        <View style={[styles.card, { backgroundColor: theme.colors.header.background }]}>
            {Platform.OS !== 'web' && (
                <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />
            )}
            {actions.map((action, index) => {
                const isLast = index === actions.length - 1;
                const color = action.destructive ? theme.colors.status.error : theme.colors.text;

                return (
                    <Pressable
                        key={action.id}
                        accessibilityRole="button"
                        accessibilityLabel={action.label}
                        onPress={() => handleActionPress(action)}
                        style={({ pressed }) => [
                            styles.menuItem,
                            !isLast && styles.menuItemDivider,
                            pressed && styles.menuItemPressed,
                        ]}
                    >
                        <Ionicons
                            color={color}
                            name={action.icon as keyof typeof Ionicons.glyphMap}
                            size={18}
                        />
                        <Text numberOfLines={1} style={[styles.menuItemLabel, { color }]}>
                            {action.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );

    if (Platform.OS === 'web' && position) {
        return (
            <RNModal
                animationType="none"
                onRequestClose={onClose}
                transparent
                visible={visible}
            >
                <View style={styles.webContainer}>
                    <Pressable onPress={onClose} style={styles.backdrop} />
                    <View
                        style={[
                            styles.webMenu,
                            {
                                left: position.left,
                                top: position.top,
                            },
                        ]}
                    >
                        {content}
                    </View>
                </View>
            </RNModal>
        );
    }

    return (
        <RNModal
            animationType="fade"
            onRequestClose={onClose}
            transparent
            visible={visible}
        >
            <View style={styles.nativeContainer}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <View
                    style={[
                        styles.nativeSheet,
                        {
                            backgroundColor: theme.colors.header.background,
                            paddingBottom: Math.max(16, safeArea.bottom),
                        },
                    ]}
                >
                    {content}
                </View>
            </View>
        </RNModal>
    );
}
