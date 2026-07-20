import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { subscribeToSessionActionsTriggered } from './sessionActionsHintBus';
import { t } from '@/text';

/**
 * First-launch coachmark for the ⋯ session-row affordance.
 * Shows once on the home screen after the user has paired a terminal AND has
 * 2+ sessions. Decision logic in labOnboardingPersist.ts, mmkv key
 * session-actions-hint-seen-v1.
 *
 * Auto-dismisses after 8 seconds. Manual close button (×) for the user who
 * wants to dismiss immediately. Parent listens for the first ⋯ tap and calls
 * onDismiss so the hint also clears the moment the affordance is used.
 *
 */
export interface SessionActionsHintProps {
    visible: boolean;
    onDismiss: () => void;
}

export const SessionActionsHint = React.memo(function SessionActionsHint({
    visible,
    onDismiss,
}: SessionActionsHintProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    React.useEffect(() => {
        if (!visible) return;
        const timer = setTimeout(() => onDismiss(), 8000);
        const unsubscribe = subscribeToSessionActionsTriggered(() => onDismiss());
        return () => {
            clearTimeout(timer);
            unsubscribe();
        };
    }, [visible, onDismiss]);

    if (!visible) return null;

    return (
        <View style={styles.container} accessibilityRole="alert">
            <Text style={styles.emoji}>💡</Text>
            <Text style={styles.text} numberOfLines={2}>
                {t('session.actionsHintTip')}
            </Text>
            <Pressable
                onPress={onDismiss}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.dismissHint')}
                style={styles.closeButton}
            >
                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.button.primary.background,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
    },
    emoji: {
        fontSize: 18,
    },
    text: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
    },
    closeButton: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
