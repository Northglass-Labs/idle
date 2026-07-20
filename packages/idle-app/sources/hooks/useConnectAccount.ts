import * as React from 'react';
import { Platform, AppState } from 'react-native';
import { CameraView } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { authAccountApprove } from '@/auth/authAccountApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    createModernScannerSession,
    type ModernScannerSession,
} from './modernScannerSession';

interface UseConnectAccountOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectAccount(options?: UseConnectAccountOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const scannerSessionRef = React.useRef<ModernScannerSession | null>(null);

    const stopScanner = React.useCallback(async () => {
        const session = scannerSessionRef.current;
        scannerSessionRef.current = null;
        await session?.stop();
    }, []);

    useFocusEffect(
        React.useCallback(() => {
            return () => {
                void stopScanner();
            };
        }, [stopScanner])
    );

    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next !== 'active') {
                void stopScanner();
            }
        });
        return () => sub.remove();
    }, [stopScanner]);

    React.useEffect(() => {
        return () => {
            void stopScanner();
        };
    }, [stopScanner]);

    const processAuthUrl = React.useCallback(async (url: string) => {
        if (!url.startsWith('idle:///account?')) {
            Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
            return false;
        }

        setIsLoading(true);
        try {
            const tail = url.slice('idle:///account?'.length);
            const publicKey = decodeBase64(tail, 'base64url');
            const verificationCode = await authAccountApprove(
                auth.credentials!.token,
                publicKey,
                decodeBase64(auth.credentials!.secret, 'base64url'),
            );

            Modal.alert(
                'Finish linking on the new device',
                `Enter this verification code on the new device before it saves account access:\n\n${verificationCode}\n\nIf the code does not match exactly, cancel the pairing and start again.`,
                [
                {
                    text: t('common.ok'),
                    onPress: () => options?.onSuccess?.()
                }
                ],
            );
            return true;
        } catch (e) {
            console.error('Failed to connect account');
            const status = (e as { response?: { status?: unknown } })?.response?.status;
            if (status === 409) {
                Modal.alert(
                    'Pairing already claimed',
                    'Another approval reached this pairing request first. Do not trust the pending device. Cancel its pairing flow and start again with a new QR code.',
                    [{ text: t('common.ok') }],
                );
            } else {
                Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            }
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, options]);

    const connectAccount = React.useCallback(async () => {
        if (!(await checkScannerPermissions())) {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToScanQr'), [{ text: t('common.ok') }]);
            return;
        }

        await stopScanner();

        if (!CameraView.isModernBarcodeScannerAvailable) {
            Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            return;
        }

        const session = createModernScannerSession({
            camera: CameraView,
            acceptedPrefix: 'idle:///account?',
            shouldDismissScanner: Platform.OS === 'ios',
            onScan: async (data) => {
                // Explicit approval prevents an unsolicited QR code from
                // linking a device and receiving account access. Deep links
                // cross the same confirmation boundary.
                const approved = await Modal.confirm(
                    'Link a new device?',
                    'A QR code is requesting to link a new device to your Idle account. The new device will have full access to all your sessions. Approve only if you initiated this from the new device yourself.',
                    {
                        cancelText: t('common.cancel'),
                        confirmText: 'Link Device',
                        destructive: true,
                    }
                );
                if (approved) {
                    await processAuthUrl(data);
                }
            },
            onError: () => console.warn('Account scanner session failed'),
        });
        scannerSessionRef.current = session;
        try {
            await session.launch();
        } catch (error) {
            if (scannerSessionRef.current === session) {
                scannerSessionRef.current = null;
            }
            console.error('Failed to launch account scanner');
            Modal.alert(t('common.error'), t('modals.failedToLinkDevice'), [{ text: t('common.ok') }]);
            options?.onError?.(error);
        }
    }, [checkScannerPermissions, options, processAuthUrl, stopScanner]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await processAuthUrl(url);
    }, [processAuthUrl]);

    return {
        connectAccount,
        connectWithUrl,
        isLoading,
        processAuthUrl
    };
}
