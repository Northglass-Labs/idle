import React, { useCallback } from 'react';
import { View, Text, Animated, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Application from 'expo-application';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import {
    getOperationalSessionMetadata,
    useSession,
    useIsDataReady,
} from '@/sync/storage';
import { getSessionName, useSessionStatus, formatOSPlatform, formatPathRelativeToHome, getSessionAvatarId, getResumeCommand } from '@/utils/sessionUtils';
import * as Clipboard from 'expo-clipboard';
import { Modal } from '@/modal';
import { sessionArchive, sessionKill, sessionDelete } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import { Session } from '@/sync/storageTypes';
import { useIdleAction } from '@/hooks/useIdleAction';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { IdleError } from '@/utils/errors';
import { getOperationalSessionIndicators } from '@/sync/sessionOperationalState';

// Animated status dot component
function StatusDot({ color, isPulsing, size = 8 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, {
                        toValue: 0.3,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                    Animated.timing(pulseAnim, {
                        toValue: 1,
                        duration: 1000,
                        useNativeDriver: true,
                    }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
        />
    );
}

function formatSandboxMetadata(sandbox: unknown, homeDir?: string): string {
    if (sandbox === null || sandbox === undefined) {
        return 'Disabled';
    }

    if (typeof sandbox === 'string') {
        return sandbox;
    }

    if (typeof sandbox !== 'object') {
        return String(sandbox);
    }

    const value = sandbox as Record<string, unknown>;
    if (value.enabled === false) {
        return 'Disabled';
    }

    const parts: string[] = ['Enabled'];
    const isolation = typeof value.sessionIsolation === 'string' ? value.sessionIsolation : undefined;
    const networkMode = typeof value.networkMode === 'string' ? value.networkMode : undefined;
    const workspaceRoot = typeof value.workspaceRoot === 'string' ? value.workspaceRoot : undefined;

    if (isolation) {
        parts.push(`isolation=${isolation}`);
    }
    if (networkMode) {
        parts.push(`network=${networkMode}`);
    }
    if (workspaceRoot) {
        parts.push(`workspace=${formatPathRelativeToHome(workspaceRoot, homeDir)}`);
    }

    return parts.join(' | ');
}

function formatDangerouslySkipPermissionsMetadata(
    value: unknown,
    flavor: string | null | undefined,
    permissionMode: Session['permissionMode'],
    sandbox: unknown,
): string {
    if (typeof value === 'boolean') {
        return value ? 'Enabled' : 'Disabled';
    }

    if (permissionMode === 'bypassPermissions' || permissionMode === 'yolo') {
        return 'Enabled';
    }

    if (flavor === 'claude' && sandbox && typeof sandbox === 'object') {
        const sandboxValue = sandbox as Record<string, unknown>;
        if (sandboxValue.enabled === true) {
            return 'Enabled';
        }
    }

    return 'Unknown';
}

function SessionInfoContent({ session }: { session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const sessionName = getSessionName(session);
    const sessionStatus = useSessionStatus(session);
    const operationalIndicators = getOperationalSessionIndicators(session);
    const operationalMetadata = getOperationalSessionMetadata(session.metadata);
    const {
        canShowResume,
        canFork,
        forking,
        forkSession,
        openDuplicateSheet,
        resumeSession,
        resumeSessionSubtitle,
    } = useSessionQuickActions(session);

    // Check if CLI version is outdated
    const isCliOutdated = operationalMetadata?.version
        && !isVersionSupported(operationalMetadata.version, MINIMUM_CLI_VERSION);

    const handleCopySessionId = useCallback(async () => {
        if (!session) return;
        try {
            await Clipboard.setStringAsync(session.id);
            Modal.alert(t('common.success'), t('sessionInfo.idleSessionIdCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('sessionInfo.failedToCopySessionId'));
        }
    }, [session]);

    // Use IdleAction for archiving - it handles errors automatically
    const [archivingSession, performArchive] = useIdleAction(async () => {
        // Prompt for worktree cleanup before killing (needs an active machine connection)
        await maybeCleanupWorktree(session.id, operationalMetadata?.path, operationalMetadata?.machineId);

        // Try to kill the CLI process; if it's already dead, force-archive via server
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            await sessionArchive(session.id);
        }
        // Success - navigate back
        router.back();
        router.back();
    });

    const handleArchiveSession = useCallback(() => {
        performArchive();
    }, [performArchive]);

    // Use IdleAction for deletion - kills session first if needed, then deletes
    const [deletingSession, performDelete] = useIdleAction(async () => {
        // Prompt for worktree cleanup before killing (needs an active machine connection)
        await maybeCleanupWorktree(session.id, operationalMetadata?.path, operationalMetadata?.machineId);

        // Navigate back optimistically
        router.back();
        router.back();

        // Kill session first if it's still active (best-effort)
        if (sessionStatus.isConnected || session.active) {
            await sessionKill(session.id).catch(() => {});
        }

        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new IdleError(result.message || t('sessionInfo.failedToDeleteSession'), false);
        }
    });

    const handleDeleteSession = useCallback(() => {
        Modal.alert(
            t('sessionInfo.deleteSession'),
            t('sessionInfo.deleteSessionWarning'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.deleteSession'),
                    style: 'destructive',
                    onPress: performDelete
                }
            ]
        );
    }, [performDelete]);

    const formatDate = useCallback((timestamp: number) => {
        return new Date(timestamp).toLocaleString();
    }, []);

    const handleCopyUpdateCommand = useCallback(async () => {
        const updateCommand = 'npm install -g idle-coder@latest';
        try {
            await Clipboard.setStringAsync(updateCommand);
            Modal.alert(t('common.success'), updateCommand);
        } catch (error) {
            Modal.alert(t('common.error'), t('common.error'));
        }
    }, []);

    return (
        <>
            <ItemList>
                {/* Session Header */}
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                        <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                        <Text style={{
                            fontSize: 20,
                            fontWeight: '600',
                            marginTop: 12,
                            textAlign: 'center',
                            color: theme.colors.text,
                            ...Typography.default('semiBold')
                        }}>
                            {sessionName}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                            <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} size={10} />
                            <Text style={{
                                fontSize: 15,
                                color: sessionStatus.statusColor,
                                fontWeight: '500',
                                ...Typography.default()
                            }}>
                                {sessionStatus.statusText}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* CLI Version Warning */}
                {isCliOutdated && (
                    <ItemGroup>
                        <Item
                            title={t('sessionInfo.cliVersionOutdated')}
                            subtitle={t('sessionInfo.updateCliInstructions')}
                            icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                            onPress={handleCopyUpdateCommand}
                        />
                    </ItemGroup>
                )}

                {/* Session Details */}
                <ItemGroup>
                    <Item
                        title={t('sessionInfo.idleSessionId')}
                        subtitle={`${session.id.substring(0, 8)}...${session.id.substring(session.id.length - 8)}`}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#32D74B" />}
                        onPress={handleCopySessionId}
                    />
                    {operationalMetadata?.claudeSessionId && (
                        <Item
                            title={t('sessionInfo.claudeCodeSessionId')}
                            subtitle={`${operationalMetadata.claudeSessionId.substring(0, 8)}...${operationalMetadata.claudeSessionId.substring(operationalMetadata.claudeSessionId.length - 8)}`}
                            icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(operationalMetadata.claudeSessionId!);
                                    Modal.alert(t('common.success'), t('sessionInfo.claudeCodeSessionIdCopied'));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyClaudeCodeSessionId'));
                                }
                            }}
                        />
                    )}
                    {operationalMetadata?.codexThreadId && (
                        <Item
                            title={t('sessionInfo.codexThreadId')}
                            subtitle={`${operationalMetadata.codexThreadId.substring(0, 8)}...${operationalMetadata.codexThreadId.substring(operationalMetadata.codexThreadId.length - 8)}`}
                            icon={<Ionicons name="terminal-outline" size={29} color="#10A37F" />}
                            onPress={async () => {
                                try {
                                    await Clipboard.setStringAsync(operationalMetadata.codexThreadId!);
                                    Modal.alert(t('common.success'), t('sessionInfo.codexThreadIdCopied'));
                                } catch (error) {
                                    Modal.alert(t('common.error'), t('sessionInfo.failedToCopyCodexThreadId'));
                                }
                            }}
                        />
                    )}
                    {/* Resume commands are shown only when authenticated metadata supplies a supported backend identity. */}
                    {!sessionStatus.isConnected && getResumeCommand(session) && (
                        <CopyableItem
                            title="Resume Command"
                            subtitle={getResumeCommand(session)!}
                            icon={<Ionicons name="play-circle-outline" size={29} color="#30D158" />}
                            copyText={getResumeCommand(session)!}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.connectionStatus')}
                        detail={sessionStatus.isConnected ? t('status.online') : t('status.offline')}
                        icon={<Ionicons name="pulse-outline" size={29} color={sessionStatus.isConnected ? "#34C759" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.created')}
                        subtitle={formatDate(session.createdAt)}
                        icon={<Ionicons name="calendar-outline" size={29} color="#32D74B" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.lastUpdated')}
                        subtitle={formatDate(session.updatedAt)}
                        icon={<Ionicons name="time-outline" size={29} color="#32D74B" />}
                        showChevron={false}
                    />
                    <Item
                        title={t('sessionInfo.sequence')}
                        detail={session.seq.toString()}
                        icon={<Ionicons name="git-commit-outline" size={29} color="#32D74B" />}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Quick Actions */}
                <ItemGroup title={t('sessionInfo.quickActions')}>
                    {operationalMetadata?.machineId && (
                        <Item
                            title={t('sessionInfo.viewMachine')}
                            subtitle={t('sessionInfo.viewMachineSubtitle')}
                            icon={<Ionicons name="server-outline" size={29} color="#32D74B" />}
                            onPress={() => router.push(`/machine/${operationalMetadata.machineId}`)}
                        />
                    )}
                    {canShowResume && (
                        <Item
                            title={t('sessionInfo.resumeSession')}
                            subtitle={resumeSessionSubtitle}
                            icon={<Ionicons name="play-circle-outline" size={29} color="#32D74B" />}
                            onPress={resumeSession}
                        />
                    )}
                    {canFork && (
                        <Item
                            title={t('session.forkAction')}
                            subtitle={t('session.forkSubtitle')}
                            icon={<Ionicons name="git-branch-outline" size={29} color="#007AFF" />}
                            onPress={forkSession}
                            loading={forking}
                        />
                    )}
                    {canFork && (
                        <Item
                            title={t('session.duplicateAction')}
                            subtitle={t('session.duplicateSubtitle')}
                            icon={<Ionicons name="time-outline" size={29} color="#007AFF" />}
                            onPress={openDuplicateSheet}
                        />
                    )}
                    {operationalMetadata?.parentSessionId && (
                        <Item
                            title={t('session.forkedFromLabel')}
                            subtitle={t('session.forkedFromSubtitle')}
                            icon={<Ionicons name="return-up-back-outline" size={29} color="#5856D6" />}
                            onPress={() => router.push(`/session/${operationalMetadata.parentSessionId}`)}
                        />
                    )}
                    <Item
                        title={t('sessionInfo.archiveSession')}
                        subtitle={t('sessionInfo.archiveSessionSubtitle')}
                        icon={<Ionicons name="archive-outline" size={29} color="#FF3B30" />}
                        onPress={handleArchiveSession}
                    />
                    <Item
                        title={t('sessionInfo.deleteSession')}
                        subtitle={t('sessionInfo.deleteSessionSubtitle')}
                        icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                        onPress={handleDeleteSession}
                    />
                </ItemGroup>

                {/* Metadata */}
                {session.metadata && (
                    <ItemGroup title={t('sessionInfo.metadata')}>
                        <Item
                            title={t('sessionInfo.host')}
                            subtitle={session.metadata.host}
                            icon={<Ionicons name="desktop-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        <Item
                            title={t('sessionInfo.path')}
                            subtitle={formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir)}
                            icon={<Ionicons name="folder-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        {session.metadata.version && (
                            <Item
                                title={t('sessionInfo.cliVersion')}
                                subtitle={session.metadata.version}
                                detail={isCliOutdated ? '⚠️' : undefined}
                                icon={<Ionicons name="git-branch-outline" size={29} color={isCliOutdated ? "#FF9500" : "#28A745"} />}
                                showChevron={false}
                            />
                        )}
                        {session.metadata.os && (
                            <Item
                                title={t('sessionInfo.operatingSystem')}
                                subtitle={formatOSPlatform(session.metadata.os)}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color="#28A745" />}
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('sessionInfo.aiProvider')}
                            subtitle={(() => {
                                const flavor = session.metadata.flavor || 'claude';
                                if (flavor === 'claude') return 'Claude';
                                if (flavor === 'gpt' || flavor === 'openai') return 'Codex';
                                if (flavor === 'gemini') return 'Gemini';
                                if (flavor === 'openclaw') return 'OpenClaw';
                                return flavor;
                            })()}
                            icon={<Ionicons name="sparkles-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        <Item
                            title="Sandbox"
                            subtitle={formatSandboxMetadata(operationalMetadata?.sandbox, operationalMetadata?.homeDir)}
                            icon={<Ionicons name="shield-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        <Item
                            title="Dangerously Skip Permissions"
                            subtitle={formatDangerouslySkipPermissionsMetadata(
                                operationalMetadata?.dangerouslySkipPermissions,
                                operationalMetadata?.flavor,
                                session.permissionMode,
                                operationalMetadata?.sandbox,
                            )}
                            icon={<Ionicons name="warning-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        {session.metadata.hostPid && (
                            <Item
                                title={t('sessionInfo.processId')}
                                subtitle={session.metadata.hostPid.toString()}
                                icon={<Ionicons name="terminal-outline" size={29} color="#28A745" />}
                                showChevron={false}
                            />
                        )}
                        {/* iOS/Android Idle app version + build number. Read from
                            Application rather than Constants so we get
                            the runtime native version, which respects EAS
                            remote build numbering. */}
                        <Item
                            title={t('sessionInfo.idleAppVersion')}
                            subtitle={
                                Application.nativeApplicationVersion && Application.nativeBuildVersion
                                    ? `${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`
                                    : Application.nativeApplicationVersion ?? 'unknown'
                            }
                            detail={Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS}
                            icon={<Ionicons name="phone-portrait-outline" size={29} color="#28A745" />}
                            showChevron={false}
                        />
                        {session.metadata.idleHomeDir && (
                            <Item
                                title={t('sessionInfo.idleHome')}
                                subtitle={formatPathRelativeToHome(session.metadata.idleHomeDir, session.metadata.homeDir)}
                                icon={<Ionicons name="home-outline" size={29} color="#28A745" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Agent State */}
                {operationalIndicators.agentState && (
                    <ItemGroup title={t('sessionInfo.agentState')}>
                        <Item
                            title={t('sessionInfo.controlledByUser')}
                            detail={operationalIndicators.controlledByUser ? t('common.yes') : t('common.no')}
                            icon={<Ionicons name="person-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                        {operationalIndicators.hasPendingPermissions && (
                            <Item
                                title={t('sessionInfo.pendingRequests')}
                                detail={Object.keys(operationalIndicators.agentState.requests ?? {}).length.toString()}
                                icon={<Ionicons name="hourglass-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Activity */}
                <ItemGroup title={t('sessionInfo.activity')}>
                    <Item
                        title={t('sessionInfo.thinking')}
                        detail={session.thinking ? t('common.yes') : t('common.no')}
                        icon={<Ionicons name="bulb-outline" size={29} color={session.thinking ? "#FFCC00" : "#8E8E93"} />}
                        showChevron={false}
                    />
                    {session.thinking && (
                        <Item
                            title={t('sessionInfo.thinkingSince')}
                            subtitle={formatDate(session.thinkingAt)}
                            icon={<Ionicons name="timer-outline" size={29} color="#FFCC00" />}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

            </ItemList>
        </>
    );
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const isDataReady = useIsDataReady();

    // Handle three states: loading, deleted, and exists
    if (!isDataReady) {
        // Still loading data
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="hourglass-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 17, marginTop: 16, ...Typography.default('semiBold') }}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!session) {
        // Session has been deleted or doesn't exist
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, ...Typography.default('semiBold') }}>{t('errors.sessionDeleted')}</Text>
                <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32, ...Typography.default() }}>{t('errors.sessionDeletedDescription')}</Text>
            </View>
        );
    }

    return <SessionInfoContent session={session} />;
});

function CopyableItem({ title, subtitle, icon, copyText }: { title: string; subtitle: string; icon: React.ReactNode; copyText: string }) {
    const [copied, setCopied] = React.useState(false);
    return (
        <Item
            title={title}
            subtitle={subtitle}
            icon={icon}
            showChevron={false}
            rightElement={<Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={copied ? '#30D158' : '#8E8E93'} />}
            onPress={async () => {
                await Clipboard.setStringAsync(copyText);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
        />
    );
}
