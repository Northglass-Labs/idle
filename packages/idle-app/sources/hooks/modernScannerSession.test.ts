import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createModernScannerSession,
    SCANNER_SESSION_TIMEOUT_MS,
} from './modernScannerSession';

function createCamera() {
    let listener: ((event: { data: string }) => void) | null = null;
    const remove = vi.fn(() => {
        listener = null;
    });
    const launchScanner = vi.fn().mockResolvedValue(undefined);
    const dismissScanner = vi.fn().mockResolvedValue(undefined);

    return {
        camera: {
            onModernBarcodeScanned: vi.fn((next) => {
                listener = next;
                return { remove };
            }),
            launchScanner,
            dismissScanner,
        },
        emit: (data: string) => listener?.({ data }),
        remove,
        launchScanner,
        dismissScanner,
    };
}

describe('modern scanner session', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps listening through ordinary camera-alignment delays', async () => {
        const fixture = createCamera();
        const session = createModernScannerSession({
            camera: fixture.camera,
            acceptedPrefix: 'idle://terminal?',
            shouldDismissScanner: true,
            onScan: vi.fn(),
        });

        await session.launch();
        expect(fixture.launchScanner).toHaveBeenCalledWith({
            barcodeTypes: ['qr'],
            isGuidanceEnabled: false,
            isHighlightingEnabled: true,
        });
        await vi.advanceTimersByTimeAsync(15 * 1000);

        expect(fixture.remove).not.toHaveBeenCalled();
        expect(fixture.dismissScanner).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(SCANNER_SESSION_TIMEOUT_MS - 15 * 1000);

        expect(fixture.remove).toHaveBeenCalledTimes(1);
        expect(fixture.dismissScanner).toHaveBeenCalledTimes(1);
    });

    it('dismisses and removes the listener before processing one accepted QR', async () => {
        const fixture = createCamera();
        const order: string[] = [];
        fixture.remove.mockImplementation(() => order.push('remove'));
        fixture.dismissScanner.mockImplementation(async () => {
            order.push('dismiss');
        });
        const onScan = vi.fn(async () => {
            order.push('scan');
        });
        const session = createModernScannerSession({
            camera: fixture.camera,
            acceptedPrefix: 'idle:///account?',
            shouldDismissScanner: true,
            onScan,
        });

        await session.launch();
        fixture.emit('https://example.invalid/not-idle');
        expect(onScan).not.toHaveBeenCalled();

        fixture.emit('idle:///account?requester');
        fixture.emit('idle:///account?requester');
        await vi.waitFor(() => expect(onScan).toHaveBeenCalledTimes(1));

        expect(order).toEqual(['remove', 'dismiss', 'scan']);
    });

    it('cleans up a failed native launch without trying to dismiss it again', async () => {
        const fixture = createCamera();
        fixture.launchScanner.mockRejectedValueOnce(new Error('scanner unavailable'));
        const session = createModernScannerSession({
            camera: fixture.camera,
            acceptedPrefix: 'idle://terminal?',
            shouldDismissScanner: true,
            onScan: vi.fn(),
        });

        await expect(session.launch()).rejects.toThrow('scanner unavailable');
        expect(fixture.remove).toHaveBeenCalledTimes(1);
        expect(fixture.dismissScanner).not.toHaveBeenCalled();
    });

    it('makes lifecycle cleanup idempotent', async () => {
        const fixture = createCamera();
        const session = createModernScannerSession({
            camera: fixture.camera,
            acceptedPrefix: 'idle://terminal?',
            shouldDismissScanner: true,
            onScan: vi.fn(),
        });

        await session.stop();
        await session.stop();

        expect(fixture.remove).toHaveBeenCalledTimes(1);
        expect(fixture.dismissScanner).toHaveBeenCalledTimes(1);
    });
});
