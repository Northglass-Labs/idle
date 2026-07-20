import { View, ScrollView, Pressable, Platform, Text as RNText } from 'react-native';
import * as React from 'react';
import { IdleWordmark } from '@/brand';
import { Text } from '@/components/StyledText';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { useEntitlement } from '@/sync/storage';
import { getServerInfo, getServerUrl, isUsingCustomServer } from '@/sync/serverConfig';
import { openLink } from '@/utils/openLink';
import { trackPaywallButtonClicked, trackWhatsNewClicked } from '@/track';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useIdleAction } from '@/hooks/useIdleAction';
import { disconnectGitHub } from '@/sync/apiGithub';
import { useProfile } from '@/sync/storage';
import { getDisplayName, getAvatarUrl, getBio } from '@/sync/profile';
import { Avatar } from '@/components/Avatar';
import { t } from '@/text';
import { buildIssueReportBody } from './issueReport';

/**
 * Idle's task-oriented Settings implementation. SettingsView is the stable
 * integration wrapper consumed by navigation surfaces.
 *
 * Information architecture (six task-grouped sections, header, and footer):
 *   Profile header (tappable → /settings/account)
 *   PAIR TERMINAL    Scan QR, Enter URL                      (action / green)
 *   CONNECTED        Agent auth boundary, GitHub, Machines  (mixed)
 *   APP              Appearance, Voice & Speech, Language    (nav / gray)
 *   ADVANCED         Self-hosted relay, Lab features         (caution / amber)
 *   HELP & FEEDBACK  What's new, Report issue, GitHub        (nav / gray)
 *   ABOUT            Privacy, Terms, [EULA on iOS], Version  (nav / gray)
 *   Support Idle footer card                                 (action / green border)
 *
 * i18n: Section labels and menu rows resolved via t() against the
 * `settings.*` namespace.
 */
// Build provenance is injected into expo extra.app by app.config.js.
type BuildConfig = {
    buildCommitSha?: unknown;
    buildCommitTimestamp?: unknown;
};

function getBuildConfig(): BuildConfig {
    const appConfig = Constants.expoConfig?.extra?.app;
    return appConfig && typeof appConfig === 'object' ? appConfig as BuildConfig : {};
}

function formatUtcTimestamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }

    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:\d{2}Z$/, 'Z')
        .replace('T', ' ')
        .replace('Z', ' UTC');
}

function formatBuildSubtitle(buildConfig: BuildConfig): string | undefined {
    const commitTimestamp = typeof buildConfig.buildCommitTimestamp === 'string'
        ? formatUtcTimestamp(buildConfig.buildCommitTimestamp)
        : undefined;
    const commitSha = typeof buildConfig.buildCommitSha === 'string'
        ? buildConfig.buildCommitSha.slice(0, 7)
        : undefined;

    if (!commitTimestamp && !commitSha) {
        return undefined;
    }

    return [
        commitTimestamp ? `Commit ${commitTimestamp}` : 'Commit',
        commitSha,
    ].filter(Boolean).join(' / ');
}

export const IdleSettingsView = React.memo(function IdleSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : undefined;
    const versionDetail = [
        appVersion,
        runtimeVersion ? `runtime ${runtimeVersion}` : undefined,
    ].filter(Boolean).join(' / ');
    const versionSubtitle = formatBuildSubtitle(getBuildConfig());
    const auth = useAuth();
    const isPro = __DEV__ || useEntitlement('pro');
    const isCustomServer = isUsingCustomServer();
    // Offline machines stay collapsed by default so long-lived accounts remain
    // easy to scan.
    const [showOfflineMachines, setShowOfflineMachines] = React.useState(false);
    const allMachinesWithOffline = useAllMachines({ includeOffline: true });
    const offlineMachineCount = React.useMemo(
        () => allMachinesWithOffline.filter(m => !isMachineOnline(m)).length,
        [allMachinesWithOffline]
    );
    const visibleMachines = React.useMemo(
        () => showOfflineMachines
            ? allMachinesWithOffline
            : allMachinesWithOffline.filter(isMachineOnline),
        [allMachinesWithOffline, showOfflineMachines]
    );
    const profile = useProfile();
    const displayName = getDisplayName(profile);
    const avatarUrl = getAvatarUrl(profile, getServerUrl());
    const bio = getBio(profile);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    // Every settings icon resolves through a semantic action, navigation, or
    // caution token.
    const ICON_ACTION = theme.colors.button.primary.background;
    const ICON_NAV = theme.colors.textSecondary;
    const ICON_CAUTION = theme.colors.permission.sandboxedYolo;

    const handleGitHub = async () => {
        await openLink('https://github.com/Northglass-Labs/idle');
    };

    const handleReportIssue = async () => {
        // Pre-fill the GitHub issue with device + app context so the user
        // doesn't have to chase down version numbers. Uses the
        // bug_report.md template at .github/ISSUE_TEMPLATE/.
        const body = buildIssueReportBody({
            appVersion,
            platform: Platform.OS,
            osVersion: Platform.Version,
            isCustomServer,
        });
        const url = `https://github.com/Northglass-Labs/idle/issues/new?template=bug_report.md&body=${encodeURIComponent(body)}`;
        await openLink(url);
    };

    // Connection state for the CONNECTED group.
    const isGitHubConnected = !!profile.github;

    const [disconnectingGitHub, handleDisconnectGitHub] = useIdleAction(async () => {
        const confirmed = await Modal.confirm(
            t('modals.disconnectGithub'),
            t('modals.disconnectGithubConfirm'),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            await disconnectGitHub(auth.credentials!);
        }
    });

    // Keep logout visible in the primary Settings flow on every platform.
    const [loggingOut, handleLogout] = useIdleAction(async () => {
        const confirmed = await Modal.confirm(
            t('settingsAccount.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('settingsAccount.logout'), destructive: true }
        );
        if (confirmed) {
            await auth.logout();
        }
    });

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Profile header: the whole card is tappable. */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <Pressable
                    onPress={() => router.push('/settings/account')}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.account')}
                    style={({ pressed }) => [
                        styles.profileCard,
                        pressed && { opacity: 0.7 },
                    ]}
                >
                    {profile.firstName ? (
                        <>
                            <View style={{ marginBottom: 12 }}>
                                <Avatar
                                    id={profile.id}
                                    size={90}
                                    imageUrl={avatarUrl}
                                    thumbhash={profile.avatar?.thumbhash}
                                />
                            </View>
                            <Text style={{ fontSize: 20, fontWeight: '600', color: theme.colors.text, marginBottom: bio ? 4 : 8 }}>
                                {displayName}
                            </Text>
                            {bio && (
                                <Text style={{ fontSize: 14, color: theme.colors.textSecondary, textAlign: 'center', marginBottom: 8, paddingHorizontal: 16 }}>
                                    {bio}
                                </Text>
                            )}
                        </>
                    ) : (
                        <View style={{ marginBottom: 12 }}>
                            <IdleWordmark fontSize={48} />
                        </View>
                    )}
                </Pressable>
            </View>

            {/* Terminal pairing is available only on native clients. */}
            {Platform.OS !== 'web' && (
                <ItemGroup title={t('settings.sectionPairTerminal')}>
                    <Item
                        title={t('settings.scanQrCodeToAuthenticate')}
                        icon={<Ionicons name="qr-code-outline" size={29} color={ICON_ACTION} />}
                        info={t('settings.scanQrInfo')}
                        onPress={connectTerminal}
                        loading={isLoading}
                        showChevron={false}
                    />
                    <Item
                        title={t('connect.enterUrlManually')}
                        icon={<Ionicons name="link-outline" size={29} color={ICON_ACTION} />}
                        info={t('connect.enterUrlManuallyInfo')}
                        onPress={async () => {
                            const url = await Modal.prompt(
                                t('modals.authenticateTerminal'),
                                t('modals.pasteUrlFromTerminal'),
                                {
                                    placeholder: 'idle://terminal?...',
                                    confirmText: t('common.authenticate'),
                                }
                            );
                            if (url?.trim()) {
                                connectWithUrl(url.trim());
                            }
                        }}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {/* CONNECTED — credential boundary, GitHub, and paired machines */}
            <ItemGroup title={t('settings.sectionConnected')}>
                <Item
                    title={t('settings.claudeCode')}
                    subtitle="Claude Code, Codex, Gemini"
                    icon={<Ionicons name="code-slash-outline" size={29} color={ICON_NAV} />}
                    info={t('settings.claudeCodeInfo')}
                    showChevron={false}
                />
                {/* Connected GitHub accounts retain a disconnect control. */}
                {isGitHubConnected && (
                    <Item
                        title={t('settings.github')}
                        subtitle={t('settings.githubConnected', { login: profile.github?.login! })}
                        icon={
                            <Ionicons
                                name="logo-github"
                                size={29}
                                color={theme.colors.status.connected}
                            />
                        }
                        info={t('settings.githubInfo')}
                        onPress={handleDisconnectGitHub}
                        loading={disconnectingGitHub}
                        showChevron={false}
                    />
                )}
                {/* Paired machines surface here; offline entries are collapsed by default. */}
                {visibleMachines.map((machine) => {
                    const isOnline = isMachineOnline(machine);
                    const host = machine.metadata?.host || 'Unknown';
                    const machineDisplayName = machine.metadata?.displayName;
                    const platform = machine.metadata?.platform || '';

                    const title = machineDisplayName || host;

                    let subtitle = '';
                    if (machineDisplayName && machineDisplayName !== host) {
                        subtitle = host;
                    }
                    if (platform) {
                        subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                    }
                    subtitle = subtitle
                        ? `${subtitle} • ${isOnline ? t('status.online') : t('status.offline')}`
                        : (isOnline ? t('status.online') : t('status.offline'));

                    return (
                        <Item
                            key={machine.id}
                            title={title}
                            subtitle={subtitle}
                            icon={
                                <Ionicons
                                    name="desktop-outline"
                                    size={29}
                                    color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                />
                            }
                            onPress={() => router.push(`/machine/${machine.id}`)}
                        />
                    );
                })}
                {offlineMachineCount > 0 && (
                    <Item
                        title={showOfflineMachines
                            ? t('settings.hideOfflineMachines')
                            : t('settings.showOfflineMachines', { count: offlineMachineCount })}
                        onPress={() => setShowOfflineMachines(v => !v)}
                        showChevron={false}
                        titleStyle={{
                            textAlign: 'center',
                            color: theme.colors.textLink,
                        }}
                    />
                )}
            </ItemGroup>

            {/* APP — taste/preference rows; navigational icons only */}
            <ItemGroup title={t('settings.sectionApp')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={t('settings.appearanceSubtitle')}
                    icon={<Ionicons name="color-palette-outline" size={29} color={ICON_NAV} />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title={t('settings.voiceAssistant')}
                    subtitle={t('settings.voiceAssistantSubtitle')}
                    icon={<Ionicons name="mic-outline" size={29} color={ICON_NAV} />}
                    info={t('settings.voiceAssistantInfo')}
                    onPress={() => router.push('/settings/voice')}
                />
                <Item
                    title="Agent Defaults"
                    subtitle="Default model, effort, and permissions"
                    icon={<Ionicons name="options-outline" size={29} color={ICON_NAV} />}
                    onPress={() => router.push('/settings/agents' as any)}
                />
                <Item
                    title={t('settings.language')}
                    subtitle={t('settings.languageSubtitle')}
                    icon={<Ionicons name="language-outline" size={29} color={ICON_NAV} />}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* ADVANCED — power-user knobs behind the door; caution tone */}
            <ItemGroup title={t('settings.sectionAdvanced')}>
                <Item
                    title={t('server.relayServerMenuTitle')}
                    subtitle={isCustomServer
                        ? `${t('server.relayServerMenuSubtitleCustom')} — ${getServerInfo().hostname}`
                        : t('server.relayServerMenuSubtitleDefault')}
                    icon={<Ionicons name="server-outline" size={29} color={ICON_CAUTION} />}
                    info={t('server.relayServerMenuInfo')}
                    onPress={() => router.push('/server')}
                />
                <Item
                    title={t('settings.labFeatures')}
                    subtitle={t('settings.labFeaturesSubtitle')}
                    icon={<Ionicons name="flask-outline" size={29} color={ICON_CAUTION} />}
                    info={t('settings.labFeaturesInfo')}
                    onPress={() => router.push('/settings/lab')}
                />
            </ItemGroup>

            {/* Support, project, legal, and version information share one group. */}
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<Ionicons name="sparkles-outline" size={29} color={ICON_NAV} />}
                    onPress={() => {
                        trackWhatsNewClicked();
                        router.push('/changelog');
                    }}
                />
                <Item
                    title={t('settings.reportIssue')}
                    icon={<Ionicons name="bug-outline" size={29} color={ICON_NAV} />}
                    onPress={handleReportIssue}
                />
                <Item
                    title={t('settings.github')}
                    icon={<Ionicons name="logo-github" size={29} color={ICON_NAV} />}
                    detail="northglass/idle"
                    onPress={handleGitHub}
                />
                <Item
                    title={t('settings.privacyPolicy')}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={ICON_NAV} />}
                    onPress={() => openLink('https://northglass.io/privacy/')}
                />
                <Item
                    title={t('settings.termsOfService')}
                    icon={<Ionicons name="document-text-outline" size={29} color={ICON_NAV} />}
                    onPress={() => openLink('https://northglass.io/terms/')}
                />
                {Platform.OS === 'ios' && (
                    <Item
                        title={t('settings.eula')}
                        icon={<Ionicons name="document-text-outline" size={29} color={ICON_NAV} />}
                        onPress={() => openLink('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                    />
                )}
                <Item
                    title={t('common.version')}
                    subtitle={versionSubtitle}
                    subtitleLines={2}
                    detail={versionDetail}
                    icon={<Ionicons name="information-circle-outline" size={29} color={ICON_NAV} />}
                    showChevron={false}
                />
            </ItemGroup>

            {/* DANGER ZONE — Log out lives here so iOS users can find it
                without needing the CommandPalette. Per UI behavior. */}
            <ItemGroup title={t('settingsAccount.dangerZone')}>
                <Item
                    title={t('settingsAccount.logout')}
                    subtitle={t('settingsAccount.logoutSubtitle')}
                    icon={<Ionicons name="log-out-outline" size={29} color={theme.colors.status.error} />}
                    info={t('settingsAccount.logoutInfo')}
                    onPress={handleLogout}
                    loading={loggingOut}
                    destructive
                    showChevron={false}
                />
            </ItemGroup>

        </ItemList>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    profileCard: {
        alignItems: 'center',
        paddingVertical: 24,
        backgroundColor: theme.colors.surface,
        marginTop: 16,
        borderRadius: 12,
        marginHorizontal: 16,
    },
    supportCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 32,
        paddingHorizontal: 16,
        paddingVertical: 16,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: 1.5,
        borderColor: theme.colors.button.primary.background,
    },
    supportIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background + '14',
    },
    supportTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 2,
    },
    supportSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
