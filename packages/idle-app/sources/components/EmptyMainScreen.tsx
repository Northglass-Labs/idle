import React from 'react';
import { View, Text, Platform, TouchableOpacity } from 'react-native';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/RoundButton';
import { useConnectTerminal } from '@/hooks/useConnectTerminal';
import { Modal } from '@/modal';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 32,
    },
    title: {
        marginBottom: 16,
        textAlign: 'center',
        fontSize: 24,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    terminalBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 20,
        marginHorizontal: 24,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 16,
        color: theme.colors.status.connected,
    },
    terminalTextFirst: {
        marginBottom: 8,
    },
    stepsContainer: {
        marginTop: 12,
        marginHorizontal: 24,
        marginBottom: 48,
        width: 250,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    stepRowLast: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    stepNumber: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    stepNumberText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    stepText: {
        ...Typography.default(),
        fontSize: 18,
        color: theme.colors.textSecondary,
    },
    buttonsContainer: {
        alignItems: 'center',
        width: '100%',
    },
    buttonWrapper: {
        width: 240,
        marginBottom: 12,
    },
    buttonWrapperSecondary: {
        width: 240,
    },
    helpLink: {
        marginTop: 20,
        paddingVertical: 8,
        paddingHorizontal: 16,
    },
    helpLinkText: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textLink,
        textAlign: 'center',
        textDecorationLine: 'underline',
    },
}));

export function EmptyMainScreen() {
    const router = useRouter();
    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal({
        onSuccess: () => router.replace('/new'),
    });
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <View style={styles.container} testID="empty-main-screen">
            {/* Terminal-style code block */}
            <Text style={styles.title}>{t('components.emptyMainScreen.readyToCode')}</Text>
            <View style={styles.terminalBlock}>
                <Text style={[styles.terminalText, styles.terminalTextFirst]}>
                    $ npm i -g idle-coder
                </Text>
                <Text style={styles.terminalText}>
                    $ idle
                </Text>
            </View>


            {Platform.OS !== 'web' && (
                <>
                    <View style={styles.stepsContainer}>
                        <View style={styles.stepRow}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>1</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.installCli')}
                            </Text>
                        </View>
                        <View style={styles.stepRow}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>2</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.runIt')}
                            </Text>
                        </View>
                        <View style={styles.stepRowLast}>
                            <View style={styles.stepNumber}>
                                <Text style={styles.stepNumberText}>3</Text>
                            </View>
                            <Text style={styles.stepText}>
                                {t('components.emptyMainScreen.scanQrCode')}
                            </Text>
                        </View>
                    </View>
                    <View style={styles.buttonsContainer}>
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                title={t('components.emptyMainScreen.openCamera')}
                                size="large"
                                loading={isLoading}
                                onPress={connectTerminal}
                                testID="open-camera-button"
                            />
                        </View>
                        <View style={styles.buttonWrapperSecondary}>
                            <RoundButton
                                title={t('connect.enterUrlManually')}
                                size="normal"
                                display="inverted"
                                testID="manual-url-button"
                                onPress={async () => {
                                    const url = await Modal.prompt(
                                        t('modals.authenticateTerminal'),
                                        t('modals.pasteUrlFromTerminal'),
                                        {
                                            placeholder: 'idle://terminal?...',
                                            cancelText: t('common.cancel'),
                                            confirmText: t('common.authenticate')
                                        }
                                    );

                                    if (url?.trim()) {
                                        connectWithUrl(url.trim());
                                    }
                                }}
                            />
                        </View>
                    </View>

                    {/* Reviewer/first-run help: explains that a computer running the
                        CLI is required to produce a QR / idle:// URL, so an empty
                        camera view or an empty paste box is expected, not a bug. */}
                    <TouchableOpacity
                        style={styles.helpLink}
                        testID="how-pairing-works-link"
                        onPress={() => {
                            Modal.alert(
                                t('components.emptyMainScreen.howPairingWorksTitle'),
                                t('components.emptyMainScreen.howPairingWorksBody'),
                                [{ text: t('common.ok') }]
                            );
                        }}
                    >
                        <Text style={styles.helpLinkText}>
                            {t('components.emptyMainScreen.howPairingWorks')}
                        </Text>
                    </TouchableOpacity>
                </>
            )}
        </View>
    );
}
