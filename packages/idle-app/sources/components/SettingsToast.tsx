import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/**
 * Three-second confirmation toast for Lab toggle changes, with
 * Undo CTA. Auto-dismisses after the timeout. Undo callback receives the
 * original value so the parent can revert without re-fetching state.
 */
export interface SettingsToastProps {
    message: string;
    onUndo?: () => void;
    onDismiss: () => void;
    visible: boolean;
}

export const SettingsToast = React.memo(function SettingsToast({ message, onUndo, onDismiss, visible }: SettingsToastProps) {
    const { theme } = useUnistyles();

    React.useEffect(() => {
        if (!visible) return;
        const t = setTimeout(() => onDismiss(), 3000);
        return () => clearTimeout(t);
    }, [visible, onDismiss]);

    if (!visible) return null;

    return (
        <View style={styles.container} accessibilityRole="alert">
            <Ionicons name="checkmark-circle" size={18} color={theme.colors.button.primary.background} />
            <Text style={styles.message} numberOfLines={1}>{message}</Text>
            {onUndo && (
                <Pressable onPress={onUndo} hitSlop={8} accessibilityLabel="Undo last setting change">
                    <Text style={styles.undo}>Undo</Text>
                </Pressable>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 12,
        padding: 12,
        paddingHorizontal: 16,
        marginHorizontal: 16,
        position: 'absolute',
        bottom: 90,
        left: 0,
        right: 0,
    },
    message: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
    },
    undo: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.button.primary.background,
    },
}));
