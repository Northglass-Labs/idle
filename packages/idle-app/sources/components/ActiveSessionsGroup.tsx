import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { hapticsLight } from './haptics';
import { Text } from '@/components/StyledText';
import { Session, Machine } from '@/sync/storageTypes';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSessionStatus, getSessionAvatarId, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { useSessionDisplayName } from '@/hooks/useSessionDisplayName';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { storage, useAllMachines, type SessionRowData } from '@/sync/storage';
import { StyleSheet } from 'react-native-unistyles';
import { ProjectGitStatus } from './ProjectGitStatus';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { SettingsToast } from './SettingsToast';
import { loadSwipeRemovedHintFlag, markSwipeRemovedHintSeen } from '@/sync/persistence';
import { notifySessionActionsTriggered } from './sessionActionsHintBus';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 8,
    },
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 8,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    sectionHeader: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    sectionHeaderLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 8,
    },
    sectionHeaderPath: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    sectionHeaderMachine: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        maxWidth: 150,
        textAlign: 'right',
    },
    sessionRow: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.surface,
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
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
        marginBottom: 4,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        ...Typography.default('semiBold'),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
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
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    newSessionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    newSessionButtonDisabled: {
        opacity: 0.5,
    },
    newSessionButtonContent: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    newSessionButtonIcon: {
        marginRight: 6,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    newSessionButtonText: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    newSessionButtonTextDisabled: {
        color: theme.colors.textSecondary,
    },
    taskStatusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 4,
        height: 16,
        borderRadius: 4,
    },
    taskStatusText: {
        fontSize: 10,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

interface ActiveSessionsGroupProps {
    // The list model emits lightweight row data. This detailed renderer needs
    // full session state for status, actions, and Git metadata, so it resolves
    // each row through the authenticated store by ID.
    sessions: SessionRowData[];
    selectedSessionId?: string;
}


export function ActiveSessionsGroup({ sessions: sessionRows, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const sessionsMap = storage((state) => state.sessions);
    const sessions = React.useMemo(
        () => sessionRows
            .map((row) => sessionsMap[row.id])
            .filter((s): s is Session => !!s),
        [sessionRows, sessionsMap],
    );
    const machines = useAllMachines();
    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by project, then associate with machine
    const projectGroups = React.useMemo(() => {
        const groups = new Map<string, {
            path: string;
            displayPath: string;
            machines: Map<string, {
                machine: Machine | null;
                machineName: string;
                sessions: Session[];
            }>;
        }>();

        const unknownSentinel = 'unknown';
        const unknownLabel = `<${t('status.unknown')}>`;
        sessions.forEach(session => {
            const projectPath = session.metadata?.path || '';
            const machineId = session.metadata?.machineId || unknownSentinel;

            // Get machine info
            const machine = machineId !== unknownSentinel ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownSentinel ? machineId : unknownLabel);

            // Get or create project group
            let projectGroup = groups.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.metadata?.homeDir);
                projectGroup = {
                    path: projectPath,
                    displayPath,
                    machines: new Map()
                };
                groups.set(projectPath, projectGroup);
            }

            // Get or create machine group within project
            let machineGroup = projectGroup.machines.get(machineId);
            if (!machineGroup) {
                machineGroup = {
                    machine,
                    machineName,
                    sessions: []
                };
                projectGroup.machines.set(machineId, machineGroup);
            }

            // Add session to machine group
            machineGroup.sessions.push(session);
        });

        // Sort sessions within each machine group by creation time (newest first)
        groups.forEach(projectGroup => {
            projectGroup.machines.forEach(machineGroup => {
                machineGroup.sessions.sort((a, b) => b.createdAt - a.createdAt);
            });
        });

        return groups;
    }, [sessions, machinesMap]);

    // Sort project groups by display path
    const sortedProjectGroups = React.useMemo(() => {
        return Array.from(projectGroups.entries()).sort(([, groupA], [, groupB]) => {
            return groupA.displayPath.localeCompare(groupB.displayPath);
        });
    }, [projectGroups]);

    return (
        <View style={styles.container}>
            {sortedProjectGroups.map(([projectPath, projectGroup]) => {
                // Get the first machine name from this project's machines
                const firstMachine = Array.from(projectGroup.machines.values())[0];
                const machineName = projectGroup.machines.size === 1
                    ? firstMachine?.machineName
                    : t('machine.multipleMachines', { count: projectGroup.machines.size });

                return (
                    <View key={projectPath}>
                        {/* Section header on grouped background */}
                        <View style={styles.sectionHeader}>
                            <View style={styles.sectionHeaderLeft}>
                                <Text style={styles.sectionHeaderPath}>
                                    {projectGroup.displayPath}
                                </Text>
                            </View>
                            {/* Show git status instead of machine name */}
                            {(() => {
                                // Get the first session from any machine in this project
                                const firstSession = Array.from(projectGroup.machines.values())[0]?.sessions[0];
                                return firstSession ? (
                                    <ProjectGitStatus sessionId={firstSession.id} />
                                ) : (
                                    <Text style={styles.sectionHeaderMachine} numberOfLines={1}>
                                        {machineName}
                                    </Text>
                                );
                            })()}
                        </View>

                        {/* Card with just the sessions */}
                        <View style={styles.projectCard}>
                            {/* Sessions grouped by machine within the card */}
                            {Array.from(projectGroup.machines.entries())
                                .sort(([, machineA], [, machineB]) => machineA.machineName.localeCompare(machineB.machineName))
                                .map(([machineId, machineGroup]) => (
                                    <View key={`${projectPath}-${machineId}`}>
                                        {machineGroup.sessions.map((session, index) => (
                                            <CompactSessionRow
                                                key={session.id}
                                                session={session}
                                                selected={selectedSessionId === session.id}
                                                showBorder={index < machineGroup.sessions.length - 1 ||
                                                    Array.from(projectGroup.machines.keys()).indexOf(machineId) < projectGroup.machines.size - 1}
                                            />
                                        ))}
                                    </View>
                                ))}
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

// Compact session row component with status line.
// Swipeable wrapper removed. The
// archive action moves to SessionActionsPopover (reached via ⋯ tap or
// long-press). A one-time toast fires when a
// user reaches for the now-gone left-swipe so they know where archive went.
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: Session; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const sessionStatus = useSessionStatus(session);
    const sessionName = useSessionDisplayName(session);
    const navigateToSession = useNavigateToSession();
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const [swipeToastVisible, setSwipeToastVisible] = React.useState(false);

    const avatarId = React.useMemo(() => {
        return getSessionAvatarId(session);
    }, [session]);

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

    const webMenuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {};

    // Native long-press → SessionActionsPopover.
    const openActionsAt = React.useCallback((pageX: number, pageY: number) => {
        hapticsLight();
        notifySessionActionsTriggered();
        setActionsAnchor({ type: 'point', x: pageX, y: pageY });
    }, []);

    // Swipe-removed hint: leftward Pan detects the muscle-memory reach for
    // the old swipe-to-archive. Fires the toast exactly once globally via
    // mmkv flag (set in persistence.ts as SWIPE_REMOVED_HINT_KEY).
    const fireSwipeRemovedHint = React.useCallback(() => {
        if (loadSwipeRemovedHintFlag()) return;
        markSwipeRemovedHintSeen();
        setSwipeToastVisible(true);
    }, []);

    const longPressGesture = React.useMemo(() =>
        Gesture.LongPress()
            .minDuration(350)
            .onStart((e) => {
                runOnJS(openActionsAt)(e.absoluteX, e.absoluteY);
            }),
        [openActionsAt]
    );

    const swipeRemovedGesture = React.useMemo(() =>
        Gesture.Pan()
            .activeOffsetX([-Infinity, -20])
            .onStart(() => {
                runOnJS(fireSwipeRemovedHint)();
            }),
        [fireSwipeRemovedHint]
    );

    const composedGesture = React.useMemo(
        () => Gesture.Race(longPressGesture, swipeRemovedGesture),
        [longPressGesture, swipeRemovedGesture],
    );

    return (
        <>
            <GestureDetector gesture={composedGesture}>
                <Pressable
                    testID="active-session-row"
                    style={[
                        styles.sessionRow,
                        showBorder && styles.sessionRowWithBorder,
                        selected && styles.sessionRowSelected
                    ]}
                    onPress={handlePress}
                    {...webMenuProps}
                >
                    <View style={styles.avatarContainer}>
                        <Avatar id={avatarId} size={48} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                    </View>
                    <View style={styles.sessionContent}>
                        {/* Title line */}
                        <View style={styles.sessionTitleRow}>
                            <Text
                                style={[
                                    styles.sessionTitle,
                                    sessionStatus.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                                ]}
                                numberOfLines={2}
                            >
                                {sessionName}
                            </Text>
                        </View>

                        {/* Status line with dot */}
                        <View style={styles.statusRow}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <View style={styles.statusDotContainer}>
                                    <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} />
                                </View>
                                <Text style={[
                                    styles.statusText,
                                    { color: sessionStatus.statusColor }
                                ]}>
                                    {sessionStatus.statusText}
                                </Text>
                            </View>

                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, transform: [{ translateY: 1 }] }}>
                                {session.draft && (
                                    <View style={styles.taskStatusContainer}>
                                        <Ionicons
                                            name="create-outline"
                                            size={10}
                                            color={styles.taskStatusText.color}
                                        />
                                    </View>
                                )}

                                {session.todos && session.todos.length > 0 && (() => {
                                    const totalTasks = session.todos.length;
                                    const completedTasks = session.todos.filter(t => t.status === 'completed').length;

                                    if (completedTasks === totalTasks) {
                                        return null;
                                    }

                                    return (
                                        <View style={styles.taskStatusContainer}>
                                            <Ionicons
                                                name="bulb-outline"
                                                size={10}
                                                color={styles.taskStatusText.color}
                                                style={{ marginRight: 2 }}
                                            />
                                            <Text style={styles.taskStatusText}>
                                                {completedTasks}/{totalTasks}
                                            </Text>
                                        </View>
                                    );
                                })()}
                            </View>
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
            <SettingsToast
                message={t('session.archiveMovedToast')}
                onDismiss={() => setSwipeToastVisible(false)}
                visible={swipeToastVisible}
            />
        </>
    );
});
