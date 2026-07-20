import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';

/**
 * "Nothing's running yet" hint shown when no Lab flags are enabled.
 * Disappears once any flag is on.
 */
export const LabEmptyState = React.memo(function LabEmptyState({ visible }: { visible: boolean }) {
    if (!visible) return null;

    return (
        <View style={styles.card}>
            <Text style={styles.flask}>⚗</Text>
            <Text style={styles.title}>{t('lab.emptyTitle')}</Text>
            <Text style={styles.body}>{t('lab.emptyBody')}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 24,
        marginHorizontal: 16,
        marginVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderStyle: 'dashed',
        alignItems: 'center',
    },
    flask: { fontSize: 36, opacity: 0.6, marginBottom: 8 },
    title: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 4,
    },
    body: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));
