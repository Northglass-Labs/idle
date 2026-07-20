import * as z from 'zod';

//
// Schema
//

export const LocalSettingsSchema = z.object({
    commandPaletteEnabled: z.boolean().describe('Enable CMD+K command palette (web only)'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    // Default ON for the shipped markdown renderer.
    // Users who explicitly turned it off keep their explicit `false`; new installs + users who never touched it get `true`.
    markdownCopyV2: z.boolean().describe('Rich markdown copy: long-press a message to open the full-text selection view (preserves code fences, lists, tables). Default on.'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    // Per-device UI toggles
    showMessageTimestamps: z.boolean().describe('Show timestamps under chat bubbles + on session rows'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    // User-renamed session display names — keyed by sessionId. Device-local
    // override; the CLI keeps owning the canonical session metadata
    // (`metadata.summary.text` etc.), this just lets the user pin a
    // friendlier label on the device they care about. Empty/missing entry
    // means fall through to the normal name resolution.
    customSessionNames: z.record(z.string(), z.string()).describe('User-renamed session names (sessionId → display name, device-local)'),
    // Where tap-to-open links render. 'in-app' (default) uses Safari View
    // Controller on iOS / Custom Tab on Android — modal in-app browser
    // that keeps the user's session context. 'external' bounces to the
    // OS default browser. Some URLs (App Store, mailto:, custom schemes)
    // always go external regardless — see sources/utils/resolveLinkOpener.
    linksOpenIn: z.enum(['in-app', 'external']).describe('Where tap-to-open links render: in-app browser or external default browser'),
    // Composer image attachments remain device opt-in. Streamed reads and the
    // authenticated attachment routes enforce file and storage quotas.
    experimentalAttachments: z.boolean().describe('Enable image paste, picker, and drop in the composer (default off until attachment routes are configured)'),
    // Co-author credit is off by default: sessions carry no Co-Authored-By
    // trailer unless the user opts in. The daemon passes the preference to
    // each spawned session.
    commitAttribution: z.boolean().describe('Add a Co-Authored-By: Idle credit to commits made through Idle (off by default)'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    commandPaletteEnabled: false,
    themePreference: 'dark',
    markdownCopyV2: true,
    zenMode: false,
    showMessageTimestamps: true,
    acknowledgedCliVersions: {},
    customSessionNames: {},
    linksOpenIn: 'in-app',
    experimentalAttachments: false,
    commitAttribution: false,
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return { ...localSettingsDefaults, ...parsed.data };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
