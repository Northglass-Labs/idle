import { describe, it, expect } from 'vitest';
import { resolveLinkOpener, LinkOpenMode } from './resolveLinkOpener';

describe('resolveLinkOpener — picks the right primitive based on setting', () => {
    // Contract: callers pass the user's chosen mode; resolveLinkOpener returns
    // 'in-app' (Expo's WebBrowser.openBrowserAsync — Safari View Controller on
    // iOS) or 'external' (React Native's Linking.openURL — bounces to default
    // browser). OAuth flows + App-Store URLs override the setting because
    // they functionally require their specific primitive.

    it('respects user mode "in-app" for a normal https URL', () => {
        expect(resolveLinkOpener('https://example.com', 'in-app')).toBe('in-app');
    });

    it('respects user mode "external" for a normal https URL', () => {
        expect(resolveLinkOpener('https://example.com', 'external')).toBe('external');
    });

    it('forces "external" for App Store URLs regardless of setting', () => {
        // App Store URLs need to bounce out to the App Store app, not
        // render in an embedded webview (which would 404 or show a
        // download-blocked placeholder).
        expect(resolveLinkOpener('https://apps.apple.com/app/idle/id1234567890', 'in-app')).toBe('external');
        expect(resolveLinkOpener('https://apps.apple.com/...', 'external')).toBe('external');
    });

    it('forces "external" for Play Store URLs regardless of setting', () => {
        expect(resolveLinkOpener('https://play.google.com/store/apps/details?id=com.northglass.idle', 'in-app')).toBe('external');
        expect(resolveLinkOpener('market://details?id=foo', 'in-app')).toBe('external');
    });

    it('forces "external" for mailto: and tel: links', () => {
        // These hand off to the OS handler — in-app browser does nothing useful.
        expect(resolveLinkOpener('mailto:hello@northglass.io', 'in-app')).toBe('external');
        expect(resolveLinkOpener('tel:+15555551234', 'in-app')).toBe('external');
    });

    it('forces "external" for non-http(s) schemes (custom URL handlers)', () => {
        expect(resolveLinkOpener('zoommtg://...', 'in-app')).toBe('external');
        expect(resolveLinkOpener('slack://channel?team=T123', 'in-app')).toBe('external');
    });

    it('defaults to in-app when given an invalid mode (defensive)', () => {
        expect(resolveLinkOpener('https://example.com', undefined as unknown as LinkOpenMode)).toBe('in-app');
        expect(resolveLinkOpener('https://example.com', 'garbage' as unknown as LinkOpenMode)).toBe('in-app');
    });

    it('handles empty / nonsense URLs gracefully (still picks a mode)', () => {
        // The caller's openLink() handles "should I even try" — this just
        // picks the primitive. Pick "external" so the OS gets the chance
        // to either handle or reject, rather than us showing an empty
        // Safari View Controller.
        expect(resolveLinkOpener('', 'in-app')).toBe('external');
    });
});
