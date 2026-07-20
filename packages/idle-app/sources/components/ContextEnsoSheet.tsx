import * as React from 'react';
import { Modal as RNModal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { ContextEnso } from '@/components/ContextEnso';
import { hapticsLight } from '@/components/haptics';
import { buildContextEnsoSheetContent } from './contextEnsoSheetContent';

/**
 * Bottom-sheet "context window" detail view, opened by tapping the ContextEnso
 * ring in the composer footer.
 *
 * Presents context-window detail in a branded, copyable sheet.
 *
 * The structural-content pieces (percent text, model line,
 * rows) come from `contextEnsoSheetContent.ts` so they're unit-tested in plain
 * vitest; this file is the React Native presentation layer.
 *
 * Container pattern follows SessionActionsPopover.tsx's iOS bottom sheet
 * (Modal + transparent + slide animation + handle + safe-area-aware bottom
 * padding). No new dependencies introduced.
 *
 * AgentInput owns visibility while this component owns presentation and copy
 * behavior.
 */

const COPY_FEEDBACK_DURATION_MS = 1500;

interface ContextEnsoSheetProps {
    visible: boolean;
    onClose: () => void;
    usedTokens: number | null;
    totalTokens: number;
    model: string | null | undefined;
}

export const ContextEnsoSheet = React.memo(function ContextEnsoSheet({
    visible,
    onClose,
    usedTokens,
    totalTokens,
    model,
}: ContextEnsoSheetProps) {
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const [copied, setCopied] = React.useState(false);

    const content = React.useMemo(
        () => buildContextEnsoSheetContent({ usedTokens, totalTokens, model }),
        [usedTokens, totalTokens, model]
    );

    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    React.useEffect(() => {
        // Reset the "Copied" badge whenever the sheet re-opens, so a sheet
        // closed mid-feedback doesn't return holding stale state.
        if (!visible) setCopied(false);
    }, [visible]);

    const onCopyCompact = React.useCallback(async () => {
        await Clipboard.setStringAsync('/compact');
        hapticsLight();
        setCopied(true);
    }, []);

    // Percent text color follows the same warning/critical thresholds as the ring itself.
    const percentColor =
        content.kind === 'data' && content.percentTier === 'critical'
            ? theme.colors.warningCritical
            : content.kind === 'data' && content.percentTier === 'warning'
              ? theme.colors.warning
              : theme.colors.text;

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
                accessibilityLabel="Close context window details"
            >
                {/* Inner Pressable swallows taps so the card itself doesn't close on press. */}
                <Pressable
                    style={[
                        styles.sheet,
                        {
                            paddingBottom: Math.max(insets.bottom + 8, 16),
                            backgroundColor: theme.colors.header.background,
                        },
                    ]}
                    onPress={() => {}}
                    testID="context-enso-sheet"
                >
                    {/* Drag handle */}
                    <View style={[styles.handle, { backgroundColor: theme.colors.textSecondary }]} />

                    {/* Large ensō glyph — visual continuity with the composer ring */}
                    <View style={styles.glyphRow}>
                        <ContextEnso usedTokens={usedTokens} totalTokens={totalTokens} size={48} />
                    </View>

                    {content.kind === 'data' && (
                        <>
                            <Text
                                style={[
                                    styles.percentText,
                                    { color: percentColor },
                                ]}
                            >
                                {content.percentText}
                            </Text>
                            <Text style={[styles.modelLine, { color: theme.colors.textSecondary }]}>
                                {content.modelLine}
                            </Text>
                        </>
                    )}

                    {content.kind === 'no-data' && (
                        <>
                            <Text style={[styles.percentText, { color: theme.colors.text }]}>
                                No usage data yet
                            </Text>
                            <Text style={[styles.modelLine, { color: theme.colors.textSecondary }]}>
                                Send a message to fill the context window.
                            </Text>
                        </>
                    )}

                    <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />

                    <View style={styles.rowsContainer}>
                        {content.rows.map((row) => (
                            <View key={row.label} style={styles.row}>
                                <Text style={[styles.rowLabel, { color: theme.colors.textSecondary }]}>
                                    {row.label}
                                </Text>
                                <Text
                                    style={[
                                        styles.rowValue,
                                        { color: theme.colors.text },
                                        row.mono ? Typography.mono() : Typography.default(),
                                    ]}
                                >
                                    {row.value}
                                </Text>
                            </View>
                        ))}
                    </View>

                    {content.showTip && (
                        <Pressable
                            onPress={onCopyCompact}
                            style={({ pressed }) => [
                                styles.tipCard,
                                {
                                    backgroundColor: theme.colors.input.background,
                                    borderColor: theme.colors.divider,
                                    opacity: pressed ? 0.7 : 1,
                                },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Copy slash compact command"
                            testID="context-enso-sheet-tip"
                        >
                            <Text style={styles.tipPrompt}>$</Text>
                            <Text style={[styles.tipCommand, { color: theme.colors.text }]}>
                                /compact
                            </Text>
                            <Text style={[styles.tipHint, { color: theme.colors.textSecondary }]}>
                                {copied ? 'copied' : 'tap to copy'}
                            </Text>
                        </Pressable>
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
        paddingHorizontal: 20,
    },
    handle: {
        width: 40,
        height: 4,
        borderRadius: 999,
        marginTop: 2,
        marginBottom: 12,
        alignSelf: 'center',
        opacity: 0.5,
    },
    glyphRow: {
        alignItems: 'center',
        marginTop: 8,
        marginBottom: 12,
    },
    percentText: {
        fontSize: 28,
        textAlign: 'center',
        ...Typography.mono('semiBold'),
    },
    modelLine: {
        fontSize: 13,
        textAlign: 'center',
        marginTop: 4,
        marginBottom: 16,
        ...Typography.mono(),
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        marginVertical: 4,
    },
    rowsContainer: {
        marginTop: 8,
        marginBottom: 12,
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
    },
    rowLabel: {
        fontSize: 15,
        ...Typography.default(),
    },
    rowValue: {
        fontSize: 15,
        fontVariant: ['tabular-nums'],
    },
    tipCard: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginTop: 4,
        gap: 8,
    },
    tipPrompt: {
        fontSize: 13,
        color: '#32D74B', // Idle terminal green — same accent the brand mark uses
        ...Typography.mono('semiBold'),
    },
    tipCommand: {
        fontSize: 13,
        flex: 1,
        ...Typography.mono(),
    },
    tipHint: {
        fontSize: 11,
        ...Typography.default(),
    },
}));
