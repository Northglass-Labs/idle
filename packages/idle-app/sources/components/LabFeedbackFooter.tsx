import * as React from 'react';
import { Pressable, View, Linking } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { openLink } from '@/utils/openLink';
import { t } from '@/text';

/**
 * Bottom-of-Lab card with hello@northglass.io + GitHub issue CTAs.
 * Closes the feedback loop so Lab isn't a black hole.
 */
export const LabFeedbackFooter = React.memo(function LabFeedbackFooter() {
    const { theme } = useUnistyles();

    const onEmail = React.useCallback(() => {
        void Linking.openURL('mailto:hello@northglass.io?subject=Lab%20Feature%20Feedback');
    }, []);

    const onGitHub = React.useCallback(() => {
        void openLink('https://github.com/Northglass-Labs/idle/issues/new');
    }, []);

    return (
        <View style={styles.card}>
            <Text style={styles.title}>{t('lab.feedbackTitle')}</Text>
            <Text style={styles.body}>{t('lab.feedbackBody')}</Text>
            <View style={styles.actions}>
                <Pressable style={styles.emailButton} onPress={onEmail} accessibilityLabel={t('lab.emailA11y')}>
                    <Ionicons name="mail-outline" size={14} color={theme.colors.button.primary.background} />
                    <Text style={styles.emailButtonText}>hello@northglass.io</Text>
                </Pressable>
                <Pressable style={styles.githubButton} onPress={onGitHub} accessibilityLabel={t('lab.githubA11y')}>
                    <Text style={styles.githubButtonText}>{t('lab.feedbackGitHub')}</Text>
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginHorizontal: 16,
        marginTop: 24,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    title: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 4,
    },
    body: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 18,
        marginBottom: 12,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    emailButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    emailButtonText: {
        fontSize: 13,
        color: theme.colors.button.primary.background,
    },
    githubButton: {
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    githubButtonText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
}));
