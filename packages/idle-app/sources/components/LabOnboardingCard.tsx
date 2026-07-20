import * as React from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { loadLabOnboardingFlag, markLabOnboardingSeen } from '@/sync/persistence';
import { shouldShowLabOnboarding } from './labOnboardingPersist';
import { t } from '@/text';

/**
 * One-time welcome card shown on first Lab visit. Explains
 * stability tiers and that users can leave anytime. Dismissible.
 * Persisted to mmkv as lab-onboarding-seen-v1 so it doesn't reappear.
 */
export const LabOnboardingCard = React.memo(function LabOnboardingCard() {
    const { theme } = useUnistyles();
    const [shouldShow, setShouldShow] = React.useState(() => shouldShowLabOnboarding(loadLabOnboardingFlag()));

    const dismiss = React.useCallback(() => {
        markLabOnboardingSeen();
        setShouldShow(false);
    }, []);

    if (!shouldShow) return null;

    return (
        <View style={styles.card}>
            <View style={styles.header}>
                <Text style={styles.flask}>⚗</Text>
                <Pressable onPress={dismiss} hitSlop={12} accessibilityLabel={t('lab.dismissWelcome')}>
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            <Text style={styles.title}>{t('lab.welcomeTitle')}</Text>
            <Text style={styles.body}>
                {t('lab.welcomeBodyIntro')}
                {' '}<Text style={styles.badgeExperimental}>{t('lab.badgeExperimental')}</Text>,
                {' '}<Text style={styles.badgeBeta}>{t('lab.badgeBeta')}</Text>,
                {' '}<Text style={styles.badgePreview}>{t('lab.badgePreview')}</Text>.
            </Text>
            <Text style={styles.footer}>{t('lab.welcomeFooter')}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        padding: 18,
        marginHorizontal: 16,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: theme.colors.button.primary.background + '33',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 8,
    },
    flask: { fontSize: 28 },
    title: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text,
        marginBottom: 8,
    },
    body: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    footer: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        opacity: 0.7,
        marginTop: 10,
    },
    badgeExperimental: { color: theme.colors.warning, fontWeight: '600' },
    badgeBeta: { color: theme.colors.button.primary.background, fontWeight: '600' },
    badgePreview: { color: '#6BB6FF', fontWeight: '600' },
}));
