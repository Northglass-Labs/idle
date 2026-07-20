import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { sync } from '@/sync/sync';
import { useFailedMessageDraft } from '@/sync/storage';
import { useIdleAction } from '@/hooks/useIdleAction';
import { t } from '@/text';

/**
 * Banner shown above the composer when the session's most recent send failed.
 *
 * Renders the failed message preview (truncated) plus Retry / Discard.
 * Retry re-sends via sync.retryFailedMessage; Discard just clears the
 * persisted draft. Banner self-hides as soon as the draft is cleared.
 */

interface FailedMessageBannerProps {
    sessionId: string;
}

const PREVIEW_MAX_LENGTH = 120;

function previewFromText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= PREVIEW_MAX_LENGTH) return trimmed;
    return trimmed.slice(0, PREVIEW_MAX_LENGTH).trimEnd() + '…';
}

export const FailedMessageBanner = React.memo(function FailedMessageBanner({ sessionId }: FailedMessageBannerProps) {
    const { theme } = useUnistyles();
    const draft = useFailedMessageDraft(sessionId);

    const [retrying, doRetry] = useIdleAction(async () => {
        await sync.retryFailedMessage(sessionId);
    });

    const onDiscard = React.useCallback(() => {
        sync.discardFailedMessage(sessionId);
    }, [sessionId]);

    if (!draft) return null;

    const preview = previewFromText(draft.text);

    return (
        <View style={styles.container} accessibilityRole="alert" accessibilityLabel={t('failedMessage.bannerA11y')}>
            <View style={styles.row}>
                <Ionicons name="warning" size={18} color={theme.colors.warning} />
                <Text style={styles.title}>{t('failedMessage.title')}</Text>
            </View>
            <Text style={styles.preview} numberOfLines={2}>
                {preview}
            </Text>
            <View style={styles.actions}>
                <Pressable
                    onPress={doRetry}
                    disabled={retrying}
                    style={({ pressed }) => [
                        styles.retryButton,
                        pressed && styles.retryButtonPressed,
                        retrying && styles.retryButtonDisabled,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t('failedMessage.retryA11y')}
                    testID="failed-message-retry"
                >
                    <Ionicons name="refresh" size={16} color={theme.colors.button.primary.tint} />
                    <Text style={styles.retryButtonText}>
                        {retrying ? t('failedMessage.retryInProgress') : t('failedMessage.retry')}
                    </Text>
                </Pressable>
                <Pressable
                    onPress={onDiscard}
                    style={({ pressed }) => [styles.discardButton, pressed && styles.discardButtonPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t('failedMessage.discardA11y')}
                    testID="failed-message-discard"
                >
                    <Text style={styles.discardButtonText}>{t('failedMessage.discard')}</Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginHorizontal: 12,
        marginBottom: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.warning + '4D', // 30% alpha
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    title: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.warning,
    },
    preview: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 4,
    },
    retryButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: theme.colors.button.primary.background,
    },
    retryButtonPressed: {
        opacity: 0.75,
    },
    retryButtonDisabled: {
        opacity: 0.4,
    },
    retryButtonText: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.primary.tint,
    },
    discardButton: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    discardButtonPressed: {
        opacity: 0.6,
    },
    discardButtonText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
