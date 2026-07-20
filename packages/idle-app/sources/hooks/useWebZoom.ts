import { useEffect } from 'react';
import { Platform } from 'react-native';

export const BROWSER_APP_ZOOM = 1.0;

const WEB_ZOOM_CLASS = 'idle-app-zoomed';
const WEB_ZOOM_PROPERTY = '--idle-app-zoom';

export function getBrowserAppZoomValue(): string {
    return String(BROWSER_APP_ZOOM);
}

/** Apply the browser-only layout scale without changing native rendering. */
export function useWebZoom() {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') return;

        const root = document.documentElement;
        root.style.setProperty(WEB_ZOOM_PROPERTY, getBrowserAppZoomValue());
        root.classList.add(WEB_ZOOM_CLASS);
        return () => {
            root.classList.remove(WEB_ZOOM_CLASS);
            root.style.removeProperty(WEB_ZOOM_PROPERTY);
        };
    }, []);
}
