import { useSocketStatus, useSettings } from '@/sync/storage';
import * as React from 'react';
import { Text, View, Pressable, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useHeaderHeight } from '@/utils/responsive';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { FABWide } from './FABWide';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { useRealtimeStatus } from '@/sync/storage';
import { MainView } from './MainView';
import { IdleLogoMark } from '@/brand';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import Ionicons from '@expo/vector-icons/Ionicons';

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        flex: 1,
        borderStyle: 'solid',
        backgroundColor: theme.colors.groupped.background,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: theme.colors.groupped.background,
        position: 'relative',
    },
    logoContainer: {
        width: 32,
    },
    logo: {
        height: 24,
        width: 24,
    },
    titleContainer: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'column',
        alignItems: 'center',
        pointerEvents: 'none',
    },
    titleContainerLeft: {
        flex: 1,
        flexDirection: 'column',
        alignItems: 'flex-start',
        marginLeft: 8,
        justifyContent: 'center',
    },
    titleText: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.header.tint,
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusDot: {
        marginRight: 4,
    },
    statusText: {
        fontSize: 11,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    rightContainer: {
        marginLeft: 'auto',
        alignItems: 'flex-end',
        flexDirection: 'row',
        gap: 8,
    },
    settingsButton: {
        color: theme.colors.header.tint,
    },
    notificationButton: {
        position: 'relative',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -4,
        backgroundColor: theme.colors.status.error,
        borderRadius: 8,
        minWidth: 16,
        height: 16,
        paddingHorizontal: 4,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    // Status colors
    statusConnected: {
        color: theme.colors.status.connected,
    },
    statusConnecting: {
        color: theme.colors.status.connecting,
    },
    statusDisconnected: {
        color: theme.colors.status.disconnected,
    },
    statusError: {
        color: theme.colors.status.error,
    },
    statusDefault: {
        color: theme.colors.status.default,
    },
    indicatorDot: {
        position: 'absolute',
        top: 0,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.text,
    },
}));

export const SidebarView = React.memo(() => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const headerHeight = useHeaderHeight();
    const socketStatus = useSocketStatus();
    const realtimeStatus = useRealtimeStatus();
    const settings = useSettings();

    // Only show status for problem states — "connected" is the normal/expected state
    const connectionStatus = (() => {
        const { status } = socketStatus;
        switch (status) {
            case 'connected':
                return null;
            case 'connecting':
                return {
                    color: styles.statusConnecting.color,
                    isPulsing: true,
                    text: t('status.connecting'),
                    textColor: styles.statusConnecting.color
                };
            case 'disconnected':
                return {
                    color: styles.statusDisconnected.color,
                    isPulsing: false,
                    text: t('status.disconnected'),
                    textColor: styles.statusDisconnected.color
                };
            case 'error':
                return {
                    color: styles.statusError.color,
                    isPulsing: false,
                    text: t('status.error'),
                    textColor: styles.statusError.color
                };
            default:
                return null;
        }
    })();

    // Calculate sidebar width and determine title positioning
    // Uses same formula as SidebarNavigator.tsx:18 for consistency
    const { width: windowWidth } = useWindowDimensions();
    const sidebarWidth = Math.min(Math.max(Math.floor(windowWidth * 0.3), 250), 360);
    // sidebarLeftJustified replaces the old experiments flag.
    // With sidebarLeftJustified ON: 4 icons (148px total), always left-justify.
    // Without it: 3 icons (108px total), threshold 328px → left-justify below ~340px.
    const shouldLeftJustify = settings.sidebarLeftJustified || sidebarWidth < 340;

    const handleNewSession = React.useCallback(() => {
        router.navigate('/new');
    }, [router]);

    // Title content used in both centered and left-justified modes (DRY)
    const titleContent = (
        <>
            <Text style={styles.titleText}>{t('sidebar.sessionsTitle')}</Text>
            {connectionStatus && (
                <View style={styles.statusContainer}>
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={6}
                        style={styles.statusDot}
                    />
                    <Text style={[styles.statusText, { color: connectionStatus.textColor }]}>
                        {connectionStatus.text}
                    </Text>
                </View>
            )}
        </>
    );

    return (
        <>
            <View style={[styles.container, { paddingTop: safeArea.top }]}>
                <View style={[styles.header, { height: headerHeight }]}>
                    {/* Logo - always first */}
                    <View style={styles.logoContainer}>
                        <IdleLogoMark size={38} color={theme.dark ? '#FFFFFF' : '#000000'} />
                    </View>

                    {/* Left-justified title - in document flow, prevents overlap */}
                    {shouldLeftJustify && (
                        <View style={styles.titleContainerLeft}>
                            {titleContent}
                        </View>
                    )}

                    <View style={styles.rightContainer}>
                        <Pressable
                            onPress={() => router.push('/settings')}
                            hitSlop={15}
                        >
                            <Ionicons name="settings-outline" size={24} color={theme.colors.header.tint} />
                        </Pressable>
                        <Pressable
                            onPress={handleNewSession}
                            hitSlop={15}
                        >
                            <Ionicons name="add-outline" size={28} color={theme.colors.header.tint} />
                        </Pressable>
                    </View>

                    {/* Centered title - absolute positioned over full header */}
                    {!shouldLeftJustify && (
                        <View style={styles.titleContainer}>
                            {titleContent}
                        </View>
                    )}
                </View>
                {realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="sidebar" />
                )}
                <MainView variant="sidebar" />
            </View>
            <FABWide onPress={handleNewSession} />
        </>
    )
});
