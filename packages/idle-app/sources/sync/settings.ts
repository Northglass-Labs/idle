import * as z from 'zod';
import { migrateLegacySettings } from './migrateLegacySettings';
import { AgentDefaultOverridesSchema } from './agentDefaults';

//
// Settings Schema
//

// Current schema version for backward compatibility
export const SUPPORTED_SCHEMA_VERSION = 3;

// Increment whenever the analytics disclosure or collection contract changes.
// A stored opt-in is valid only when it was recorded against this exact version.
export const ANALYTICS_CONSENT_VERSION = 1;

// Never preserve retired credential-bearing fields as forward-compatible
// unknown settings. Older clients could sync this unused value before provider
// authentication was made exclusively local.
const RETIRED_SENSITIVE_SETTING_KEYS = new Set(['inferenceOpenAIKey']);

function withoutRetiredSensitiveSettings(value: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...value };
    for (const key of RETIRED_SENSITIVE_SETTING_KEYS) {
        delete sanitized[key];
    }
    return sanitized;
}

export const SettingsSchema = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    diffStyle: z.enum(['unified', 'split']).describe('Diff view style (split is web-only)'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    analyticsConsentVersion: z.number().int().nonnegative().describe('Disclosure version under which the analytics choice was made'),
    // Legacy blanket settings are normalized into these independent feature
    // choices before validation; explicit choices always win.
    fileViewerEnabled: z.boolean().describe('Show the in-session file browser button in the composer toolbar'),
    sidebarLeftJustified: z.boolean().describe('Left-justify the sidebar on tablets (vs centered)'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),
    // Selects compact or detailed active-session rows.
    compactSessionView: z.boolean().describe('Whether to use compact view for active sessions'),
    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    expResumeSession: z.boolean().describe('Enable experimental session resume feature'),
    fileDiffsSidebar: z.boolean().describe('Show the file diffs sidebar next to the chat on desktop'),
    groupToolCalls: z.boolean().describe('Collapse consecutive tool calls into grouped containers in chat'),
    expImageUpload: z.boolean().describe('Enable experimental image upload in chat'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    voiceAssistantLanguage: z.string().nullable().describe('Preferred language for voice assistant (null for auto-detect)'),
    voiceCustomAgentId: z.string()
        .trim()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/)
        .nullable()
        .catch(null)
        .describe('Custom ElevenLabs agent ID (null to use Idle default)'),
    voiceBypassToken: z.boolean().describe('Bypass Idle server token and connect directly to ElevenLabs (requires custom agent ID)'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
    agentDefaultOverrides: AgentDefaultOverridesSchema.describe('User-selected agent defaults. Missing values use code defaults and are not sent as agent metadata.'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),
});

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
//
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;

type AnalyticsConsentState = Pick<Settings, 'analyticsOptOut' | 'analyticsConsentVersion'>;

export function analyticsConsentUpdate(enabled: boolean): AnalyticsConsentState {
    return {
        analyticsOptOut: !enabled,
        analyticsConsentVersion: ANALYTICS_CONSENT_VERSION,
    };
}

export function isAnalyticsConsentGranted(settings: AnalyticsConsentState): boolean {
    return settings.analyticsConsentVersion === ANALYTICS_CONSENT_VERSION
        && settings.analyticsOptOut === false;
}

function normalizeAnalyticsConsent<T extends AnalyticsConsentState>(settings: T): T {
    if (settings.analyticsConsentVersion === ANALYTICS_CONSENT_VERSION) {
        return settings;
    }

    // Legacy `analyticsOptOut: false` was once a default, so it is not proof of
    // consent. Unknown future disclosure versions are also fail-closed.
    return { ...settings, analyticsOptOut: true };
}

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: true,
    diffStyle: 'unified',
    analyticsOptOut: true,
    analyticsConsentVersion: 0,
    fileViewerEnabled: false,
    sidebarLeftJustified: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    avatarStyle: 'northglass',
    showFlavorIcons: false,
    compactSessionView: false,
    hideInactiveSessions: false,
    expResumeSession: false,
    fileDiffsSidebar: false,
    groupToolCalls: false,
    expImageUpload: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    voiceCustomAgentId: null,
    voiceBypassToken: false,
    preferredLanguage: null,
    recentMachinePaths: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    agentDefaultOverrides: {},
    dismissedCLIWarnings: { perMachine: {}, global: {} },
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }

    // Normalize the legacy blanket flag before parsing. Explicit per-feature
    // choices win over the inferred defaults.
    const sanitizedSettings = withoutRetiredSensitiveSettings(settings as Record<string, unknown>);
    const migrated = migrateLegacySettings(sanitizedSettings);

    const parsed = SettingsSchemaPartial.safeParse(migrated);
    if (!parsed.success) {
        // For invalid settings, preserve unknown fields but use defaults for known fields
        const unknownFields = { ...sanitizedSettings };
        // Remove all known schema fields from unknownFields
        const knownFields = Object.keys(SettingsSchema.shape);
        knownFields.forEach(key => delete unknownFields[key]);
        return { ...settingsDefaults, ...unknownFields };
    }

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (parsed.data.preferredLanguage === 'zh') {
        console.log('[Settings Migration] Converting language code from "zh" to "zh-Hans"');
        parsed.data.preferredLanguage = 'zh-Hans';
    }

    // Merge defaults, parsed settings, and preserve unknown fields
    const unknownFields = { ...sanitizedSettings };
    // Remove known fields from unknownFields to preserve only the unknown ones
    Object.keys(parsed.data).forEach(key => delete unknownFields[key]);

    return normalizeAnalyticsConsent({ ...settingsDefaults, ...parsed.data, ...unknownFields });
}

//
// Applying changes
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Apply the delta, remove retired sensitive fields, and fill missing values.
    const result = withoutRetiredSensitiveSettings({ ...settings, ...delta }) as Settings;

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return normalizeAnalyticsConsent(result);
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    const result = normalizeAnalyticsConsent(
        withoutRetiredSensitiveSettings({ ...settings }) as Partial<Settings> & AnalyticsConsentState,
    );
    const compactAgentOverrides = Object.fromEntries(
        Object.entries(settings.agentDefaultOverrides ?? {}).filter(([, value]) => (
            value && typeof value === 'object' && Object.keys(value).length > 0
        )),
    ) as Settings['agentDefaultOverrides'];
    if (Object.keys(compactAgentOverrides).length === 0) {
        delete result.agentDefaultOverrides;
    } else {
        result.agentDefaultOverrides = compactAgentOverrides;
    }
    return result;
}
