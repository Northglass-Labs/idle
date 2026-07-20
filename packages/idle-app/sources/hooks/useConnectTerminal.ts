import * as React from 'react';
import { Platform, AppState } from 'react-native';
import { CameraView } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { authApprove } from '@/auth/authApprove';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import {
    InvalidTerminalAuthUrlError,
    requestTerminalPairingConsent,
} from './terminalPairing';
import {
    createModernScannerSession,
    type ModernScannerSession,
} from './modernScannerSession';

interface UseConnectTerminalOptions {
    onSuccess?: () => void;
    onError?: (error: any) => void;
}

export function useConnectTerminal(options?: UseConnectTerminalOptions) {
    const auth = useAuth();
    const [isLoading, setIsLoading] = React.useState(false);
    const checkScannerPermissions = useCheckScannerPermissions();

    const scannerSessionRef = React.useRef<ModernScannerSession | null>(null);

    const stopScanner = React.useCallback(async () => {
        const session = scannerSessionRef.current;
        scannerSessionRef.current = null;
        await session?.stop();
    }, []);

    // Cleanup on screen blur (user navigates away from whatever screen this hook
    // is mounted in — e.g. they tap Pair, dismiss the scanner without scanning,
    // and then tab over to a chat session).
    useFocusEffect(
        React.useCallback(() => {
            return () => {
                void stopScanner();
            };
        }, [stopScanner])
    );

    // Cleanup on app background (covers the case where the user backgrounds the
    // entire app while the scanner is open or recently dismissed).
    React.useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next !== 'active') {
                void stopScanner();
            }
        });
        return () => sub.remove();
    }, [stopScanner]);

    // Cleanup on hook unmount.
    React.useEffect(() => {
        return () => {
            void stopScanner();
        };
    }, [stopScanner]);

    const requestTerminalPairing = React.useCallback(async (url: string) => {
        try {
            const connected = await requestTerminalPairingConsent(url, async (publicKey) => {
                if (!auth.credentials) throw new Error('Terminal pairing requires an authenticated account');
                setIsLoading(true);
                const responseV1 = encryptBox(
                    decodeBase64(auth.credentials.secret, 'base64url'),
                    publicKey,
                );
                const responseV2Bundle = new Uint8Array(sync.encryption.contentDataKey.length + 1);
                responseV2Bundle[0] = 0;
                responseV2Bundle.set(sync.encryption.contentDataKey, 1);
                const responseV2 = encryptBox(responseV2Bundle, publicKey);
                await authApprove(auth.credentials.token, publicKey, responseV1, responseV2);
            });
            if (!connected) return false;

            // Pairing is complete before the informational alert. Navigation
            // must not depend on a second tap of the alert button.
            options?.onSuccess?.();
            Modal.alert(t('common.success'), t('modals.terminalConnectedSuccessfully'), [
                {
                    text: t('common.ok'),
                }
            ]);
            return true;
        } catch (e) {
            if (e instanceof InvalidTerminalAuthUrlError) {
                Modal.alert(t('common.error'), t('modals.invalidAuthUrl'), [{ text: t('common.ok') }]);
                return false;
            }
            console.error('Failed to connect terminal');
            Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(e);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [auth.credentials, options]);

    const connectTerminal = React.useCallback(async () => {
        if (!(await checkScannerPermissions())) {
            Modal.alert(t('common.error'), t('modals.cameraPermissionsRequiredToConnectTerminal'), [{ text: t('common.ok') }]);
            return;
        }

        await stopScanner();

        if (!CameraView.isModernBarcodeScannerAvailable) {
            Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            return;
        }

        const session = createModernScannerSession({
            camera: CameraView,
            acceptedPrefix: 'idle://terminal?',
            shouldDismissScanner: Platform.OS === 'ios',
            onScan: requestTerminalPairing,
            onError: () => console.warn('Terminal scanner session failed'),
        });
        scannerSessionRef.current = session;
        try {
            await session.launch();
        } catch (error) {
            if (scannerSessionRef.current === session) {
                scannerSessionRef.current = null;
            }
            console.error('Failed to launch terminal scanner');
            Modal.alert(t('common.error'), t('modals.failedToConnectTerminal'), [{ text: t('common.ok') }]);
            options?.onError?.(error);
        }
    }, [checkScannerPermissions, options, requestTerminalPairing, stopScanner]);

    const connectWithUrl = React.useCallback(async (url: string) => {
        return await requestTerminalPairing(url);
    }, [requestTerminalPairing]);

    return {
        connectTerminal,
        connectWithUrl,
        isLoading,
        requestTerminalPairing,
    };
}
