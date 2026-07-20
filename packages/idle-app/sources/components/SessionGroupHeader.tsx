import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';

interface SessionGroupHeaderProps {
    groupId: string;
    name: string;
    sessionCount: number;
    isExpanded: boolean;
    onToggle: () => void;
}

export const SessionGroupHeader = React.memo(({ groupId, name, sessionCount, isExpanded, onToggle }: SessionGroupHeaderProps) => {
    const { theme } = useUnistyles();

    const handleLongPress = React.useCallback(() => {
        Modal.alert(
            name,
            undefined,
            [
                {
                    text: t('session.renameGroup'),
                    onPress: async () => {
                        const newName = await Modal.prompt(
                            t('session.renameGroupTitle'),
                            undefined,
                            { defaultValue: name }
                        );
                        if (newName && newName.trim() && newName.trim() !== name) {
                            sync.renameSessionGroup(groupId, newName.trim());
                        }
                    }
                },
                {
                    text: t('session.deleteGroup'),
                    style: 'destructive',
                    onPress: () => {
                        Modal.alert(
                            t('session.deleteGroupTitle'),
                            t('session.deleteGroupMessage'),
                            [
                                { text: t('common.cancel'), style: 'cancel' },
                                {
                                    text: t('session.deleteGroup'),
                                    style: 'destructive',
                                    onPress: () => sync.deleteSessionGroup(groupId)
                                }
                            ]
                        );
                    }
                },
                { text: t('common.cancel'), style: 'cancel' }
            ]
        );
    }, [groupId, name]);

    return (
        <Pressable
            onPress={onToggle}
            onLongPress={handleLongPress}
            style={styles.container}
        >
            <View style={styles.leftContent}>
                <Ionicons
                    name="folder-outline"
                    size={18}
                    color={theme.colors.textSecondary}
                    style={styles.icon}
                />
                <Text style={styles.name} numberOfLines={1}>{name}</Text>
                <Text style={styles.count}>{sessionCount}</Text>
            </View>
            <Ionicons
                name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={theme.colors.textSecondary}
            />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: theme.colors.groupped.background,
    },
    leftContent: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    icon: {
        marginRight: 8,
    },
    name: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
        flex: 1,
        ...Typography.default('semiBold'),
    },
    count: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginLeft: 8,
        marginRight: 8,
    },
}));
