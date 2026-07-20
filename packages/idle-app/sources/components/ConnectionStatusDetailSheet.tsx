import * as React from 'react';
import { Modal as RNModal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { hapticsLight } from '@/components/haptics';
import { useSocketDetails } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';
import { buildConnectionStatusSheetContent, type ConnectionState } from './connectionStatusSheetContent';

/**
 * Bottom-sheet detail view opened by tapping the connection-status dot in the composer footer.
 *
 * Implements the refined Variant C mock: plain-language
 * framing, primary "Try now" button only on disconnected + error states (auto-retry is in flight
 * for connecting; nothing to do for connected), diagnostic detail (server URL + last error +
 * reconnect attempts + timestamps) behind an "Show details" toggle so the default view is calm.
 *
 * The structural content (title / blurb / primary action label per state) comes from
 * `connectionStatusSheetContent.ts` which is unit-tested in plain vitest. This file is the
 * React Native presentation layer.
 *
 * StatusDot call sites only own visibility; this component owns diagnostic
 * presentation and reconnect behavior.
 */

const COPY_FEEDBACK_DURATION_MS = 1500;

interface ConnectionStatusDetailSheetProps {
    visible: boolean;
    onClose: () => void;
}

export const ConnectionStatusDetailSheet = React.memo(function ConnectionStatusDetailSheet(props: ConnectionStatusDetailSheetProps) {
    const { visible, onClose } = props;
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const details = useSocketDetails();
    const [showDetails, setShowDetails] = React.useState(false);
    const [errorCopied, setErrorCopied] = React.useState(false);

    const content = React.useMemo(
        () => buildConnectionStatusSheetContent({ state: details.status as ConnectionState }),
        [details.status]
    );

    React.useEffect(() => {
        if (!errorCopied) return;
        const timer = setTimeout(() => setErrorCopied(false), COPY_FEEDBACK_DURATION_MS);
        return () => clearTimeout(timer);
    }, [errorCopied]);

    React.useEffect(() => {
        // Reset transient UI state when sheet re-opens.
        if (!visible) {
            setErrorCopied(false);
        }
    }, [visible]);

    const onTryNow = React.useCallback(() => {
        hapticsLight();
        // socket.io's manual reconnect: disconnect + connect re-triggers the auth flow without
        // waiting for the backoff timer. Safe to call even mid-attempt — socket.io collapses
        // duplicate connects.
        apiSocket.disconnect();
        apiSocket.connect();
    }, []);

    const onCopyError = React.useCallback(async () => {
        if (!details.lastErrorMessage) return;
        await Clipboard.setStringAsync(details.lastErrorMessage);
        hapticsLight();
        setErrorCopied(true);
    }, [details.lastErrorMessage]);

    const serverUrl = React.useMemo(() => {
        try {
            return getServerUrl();
        } catch {
            return '(server URL unavailable)';
        }
    }, [visible]);

    const fmtTime = (t: number | null) => {
        if (!t) return '—';
        const d = new Date(t);
        return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    };

    return (
        <RNModal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={onClose}
            statusBarTranslucent
        >
            <Pressable
                style={styles.backdrop}
                onPress={onClose}
                accessibilityLabel="Close connection status details"
            >
                {/* Inner pressable swallows taps so the card doesn't dismiss on press. */}
                <Pressable
                    style={[
                        styles.sheet,
                        {
                            paddingBottom: Math.max(insets.bottom + 8, 16),
                            backgroundColor: theme.colors.header.background,
                        },
                    ]}
                    onPress={() => {}}
                    testID="connection-status-sheet"
                >
                    <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />

                    <View style={styles.dotRow}>
                        <View style={[styles.dot, { backgroundColor: content.dotColor }]} />
                    </View>

                    <Text style={[styles.titleText, { color: theme.colors.text }]}>{content.title}</Text>
                    <Text style={[styles.blurbText, { color: theme.colors.textSecondary }]}>{content.blurb}</Text>

                    {content.primaryActionLabel && (
                        <Pressable
                            onPress={onTryNow}
                            style={({ pressed }) => [
                                styles.primaryButton,
                                { backgroundColor: '#32D74B', opacity: pressed ? 0.7 : 1 },
                            ]}
                            accessibilityRole="button"
                            testID="connection-status-sheet-retry"
                        >
                            <Text style={styles.primaryButtonText}>{content.primaryActionLabel}</Text>
                        </Pressable>
                    )}

                    <Pressable
                        onPress={() => setShowDetails((s) => !s)}
                        style={styles.detailsToggle}
                        accessibilityRole="button"
                        testID="connection-status-sheet-toggle"
                    >
                        <Text style={[styles.detailsToggleText, { color: theme.colors.textSecondary }]}>
                            {showDetails ? 'Hide details' : 'Show details'}
                        </Text>
                    </Pressable>

                    {showDetails && (
                        <View style={styles.detailsBlock}>
                            <View style={styles.detailRow}>
                                <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Server</Text>
                                <Text
                                    style={[styles.detailValue, { color: theme.colors.text }]}
                                    numberOfLines={1}
                                    ellipsizeMode="middle"
                                >
                                    {serverUrl}
                                </Text>
                            </View>
                            <View style={styles.detailRow}>
                                <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Last connected</Text>
                                <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                                    {fmtTime(details.lastConnectedAt)}
                                </Text>
                            </View>
                            <View style={styles.detailRow}>
                                <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Last disconnected</Text>
                                <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                                    {fmtTime(details.lastDisconnectedAt)}
                                </Text>
                            </View>
                            {details.reconnectAttempts > 0 && (
                                <View style={styles.detailRow}>
                                    <Text style={[styles.detailLabel, { color: theme.colors.textSecondary }]}>Reconnect attempts</Text>
                                    <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                                        {details.reconnectAttempts}
                                    </Text>
                                </View>
                            )}
                            {details.lastErrorMessage && (
                                <Pressable
                                    onPress={onCopyError}
                                    style={({ pressed }) => [
                                        styles.errorBlock,
                                        {
                                            backgroundColor: theme.colors.input.background,
                                            borderColor: theme.colors.divider,
                                            opacity: pressed ? 0.7 : 1,
                                        },
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel="Copy last error"
                                    testID="connection-status-sheet-copy-error"
                                >
                                    <Text style={[styles.errorLabel, { color: theme.colors.textSecondary }]}>
                                        {errorCopied ? 'Copied' : 'Last error (tap to copy)'}
                                    </Text>
                                    <Text style={[styles.errorMessage, { color: theme.colors.text }]} numberOfLines={5}>
                                        {details.lastErrorMessage}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    )}
                </Pressable>
            </Pressable>
        </RNModal>
    );
});

const styles = StyleSheet.create((_theme) => ({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'flex-end',
    },
    sheet: {
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        paddingTop: 8,
        paddingHorizontal: 24,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 2,
        marginBottom: 16,
        alignSelf: 'center',
        opacity: 0.5,
    },
    dotRow: {
        alignItems: 'center',
        marginBottom: 12,
    },
    dot: {
        width: 28,
        height: 28,
        borderRadius: 999,
    },
    titleText: {
        fontSize: 22,
        textAlign: 'center',
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    blurbText: {
        fontSize: 14,
        textAlign: 'center',
        marginBottom: 20,
        lineHeight: 20,
        ...Typography.default(),
    },
    primaryButton: {
        borderRadius: 12,
        paddingVertical: 14,
        alignItems: 'center',
        marginBottom: 12,
    },
    primaryButtonText: {
        fontSize: 16,
        color: '#080808',
        ...Typography.default('semiBold'),
    },
    detailsToggle: {
        alignItems: 'center',
        paddingVertical: 8,
    },
    detailsToggleText: {
        fontSize: 13,
        ...Typography.default(),
    },
    detailsBlock: {
        marginTop: 12,
        gap: 10,
    },
    detailRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
    },
    detailLabel: {
        fontSize: 12,
        ...Typography.default(),
    },
    detailValue: {
        fontSize: 12,
        flex: 1,
        textAlign: 'right',
        ...Typography.mono(),
    },
    errorBlock: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 8,
        padding: 10,
        gap: 4,
    },
    errorLabel: {
        fontSize: 11,
        ...Typography.default(),
    },
    errorMessage: {
        fontSize: 12,
        ...Typography.mono(),
    },
}));
