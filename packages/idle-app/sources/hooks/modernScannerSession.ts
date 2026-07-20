export const SCANNER_SESSION_TIMEOUT_MS = 2 * 60 * 1000;

interface ScannerSubscription {
    remove: () => void;
}

interface ModernScannerCamera {
    onModernBarcodeScanned: (
        listener: (event: { data: string }) => void,
    ) => ScannerSubscription;
    launchScanner: (options: {
        barcodeTypes: ['qr'];
        isGuidanceEnabled: boolean;
        isHighlightingEnabled: boolean;
    }) => Promise<void>;
    dismissScanner: () => Promise<void>;
}

interface CreateModernScannerSessionOptions {
    camera: ModernScannerCamera;
    acceptedPrefix: string;
    shouldDismissScanner: boolean;
    onScan: (data: string) => Promise<unknown>;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
}

interface StopScannerSessionOptions {
    dismiss?: boolean;
}

export interface ModernScannerSession {
    launch: () => Promise<void>;
    stop: (options?: StopScannerSessionOptions) => Promise<void>;
}

/**
 * Owns one modal scanner attempt from listener registration through native
 * dismissal. Keeping these operations together prevents the camera UI from
 * remaining visible after its JavaScript listener has been removed.
 */
export function createModernScannerSession({
    camera,
    acceptedPrefix,
    shouldDismissScanner,
    onScan,
    onError,
    timeoutMs = SCANNER_SESSION_TIMEOUT_MS,
}: CreateModernScannerSessionOptions): ModernScannerSession {
    let stopped = false;
    let processing = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let subscription: ScannerSubscription | null = null;

    const reportError = (error: unknown) => {
        try {
            onError?.(error);
        } catch {
            // Cleanup must never fail because a diagnostic callback failed.
        }
    };

    const stop = async ({
        dismiss = shouldDismissScanner,
    }: StopScannerSessionOptions = {}): Promise<void> => {
        if (stopped) return;
        stopped = true;

        subscription?.remove();
        subscription = null;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }

        if (dismiss) {
            try {
                await camera.dismissScanner();
            } catch (error) {
                reportError(error);
            }
        }
    };

    const processScan = async (data: string) => {
        if (stopped || processing || !data.startsWith(acceptedPrefix)) return;
        processing = true;
        await stop();
        try {
            await onScan(data);
        } catch (error) {
            reportError(error);
        }
    };

    subscription = camera.onModernBarcodeScanned((event) => {
        void processScan(event.data);
    });
    timeout = setTimeout(() => {
        void stop();
    }, timeoutMs);

    return {
        launch: async () => {
            if (stopped) return;
            try {
                await camera.launchScanner({
                    barcodeTypes: ['qr'],
                    isGuidanceEnabled: false,
                    isHighlightingEnabled: true,
                });
            } catch (error) {
                await stop({ dismiss: false });
                throw error;
            }
        },
        stop,
    };
}
