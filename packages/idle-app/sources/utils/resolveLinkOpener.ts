/**
 * Where the user wants tap-to-open links to render.
 * - `in-app`: Safari View Controller on iOS, Custom Tab on Android.
 *   Keeps the user's session in the app; renders the page modally.
 * - `external`: bounces to the OS-default browser (Safari / Chrome).
 *   Looks like leaving the app, but the user's default browser fully
 *   owns the page (extensions, bookmarks, password manager work).
 */
export type LinkOpenMode = 'in-app' | 'external';

const APP_STORE_HOSTS = new Set([
    'apps.apple.com',
    'itunes.apple.com',
    'play.google.com',
]);

const EXTERNAL_ONLY_SCHEMES = new Set([
    'mailto:',
    'tel:',
    'sms:',
    'facetime:',
    'market:',     // Android Play Store deep link
    'itms-apps:',  // iOS App Store deep link
]);

/**
 * Pure function: picks the right link-opening primitive given a URL +
 * the user's mode. Doesn't actually open anything — see openLink() for
 * the caller-facing API that reads the setting + dispatches.
 *
 * The user's mode is RESPECTED for normal http(s) URLs. Some URLs override
 * the setting because they functionally require a specific primitive:
 *
 * - App Store / Play Store URLs must bounce externally so the OS can hand
 *   off to the App Store / Play Store app. In-app browser renders a
 *   useless preview that can't actually install.
 * - mailto:, tel:, sms:, etc. don't render as web content at all — the OS
 *   handler must take over.
 * - Custom-scheme URLs (zoommtg://, slack://) are app deep links — only
 *   the system Linking handler knows what to do.
 *
 * Lives in its own file (separate from openLink.ts which does IO) so the
 * unit tests can import it without pulling in React Native / Expo modules
 * that vitest can't parse outside a real RN build.
 */
export function resolveLinkOpener(url: string, mode: LinkOpenMode): LinkOpenMode {
    if (!url) {
        // Empty URL: let the OS reject it (in-app browser would just show
        // an empty page).
        return 'external';
    }

    // Custom schemes (anything before :// that isn't http/https) — OS handler only.
    const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*:)/i);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (EXTERNAL_ONLY_SCHEMES.has(scheme)) return 'external';
        if (scheme !== 'http:' && scheme !== 'https:') return 'external';
    }

    // App Store / Play Store URLs — must hand off to the store app.
    try {
        const u = new URL(url);
        if (APP_STORE_HOSTS.has(u.hostname.toLowerCase())) return 'external';
    } catch {
        // Invalid URL parse — treat as external so the OS gets a chance.
        return 'external';
    }

    // Defensive: invalid mode falls back to in-app (current default).
    if (mode !== 'in-app' && mode !== 'external') return 'in-app';

    return mode;
}
