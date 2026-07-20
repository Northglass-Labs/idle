import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { storage } from '@/sync/storage';
import { resolveLinkOpener, type LinkOpenMode } from './resolveLinkOpener';

// Re-export so callers can `import { openLink, LinkOpenMode } from '@/utils/openLink'`
// without two imports.
export type { LinkOpenMode };

/**
 * Open a URL. Reads the user's `linksOpenIn` localSetting to decide
 * whether to use the in-app browser (Safari View Controller) or the
 * external default browser.
 *
 * Pass `forceMode` to override the user setting for a specific call
 * (e.g., if a particular menu item should ALWAYS open externally
 * regardless of the user's setting). OAuth flows should use
 * `WebBrowser.openAuthSessionAsync` directly — not this function.
 *
 * Returns a promise that resolves when the browser is presented (in-app)
 * or the URL has been handed to the OS (external). Silently no-ops on
 * URLs the OS can't handle.
 */
export async function openLink(url: string, forceMode?: LinkOpenMode): Promise<void> {
    const userMode = forceMode
        ?? (storage.getState().localSettings.linksOpenIn ?? 'in-app');
    const target = resolveLinkOpener(url, userMode);

    try {
        if (target === 'in-app') {
            await WebBrowser.openBrowserAsync(url);
        } else {
            const supported = await Linking.canOpenURL(url);
            if (supported) {
                await Linking.openURL(url);
            }
            // If unsupported, silently no-op.
        }
    } catch {
        // Don't crash the app on a bad URL or include it in diagnostics.
        console.warn('[openLink] failed to open an external URL');
    }
}
