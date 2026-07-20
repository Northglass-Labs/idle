import { MMKV } from 'react-native-mmkv';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from './purchases';
import { Profile, profileDefaults, profileParse } from './profile';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { type LatestUsage } from './latestUsageParse';
import { type FailedMessageDraft } from './failedMessagePersist';

const mmkv = new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';
const VOICE_SOFT_PAYWALL_SHOWN_KEY = 'voice-soft-paywall-shown';
const VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY = 'voice-onboarding-prompt-load-count';
const VOICE_MESSAGE_COUNT_KEY = 'voice-message-count';
const TEMP_TEXT_TTL_MS = 10 * 60 * 1000;
const MAX_TEMP_TEXT_ENTRIES = 20;
const MAX_TEMP_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_FAILED_MESSAGE_ENTRIES = 100;
const SESSION_REPLAY_FENCE_CIPHERTEXT_KEY = 'session-replay-fences-v1';

let sessionDraftsMemory: Record<string, string> = {};
let newSessionDraftMemory: NewSessionDraft | null = null;
let profileMemory: Profile = { ...profileDefaults };
let settingsMemory: { settings: Settings; version: number | null } | null = null;
let pendingSettingsMemory: Partial<Settings> = {};
let localSettingsMemory: LocalSettings | null = null;
let sessionPermissionModesMemory: Record<string, string> = {};
let sessionModelModesMemory: Record<string, string> = {};
let sessionEffortLevelsMemory: Record<string, string> = {};
const tempTextMemory = new Map<string, { content: string; expiresAt: number }>();
const failedMessageMemory = new Map<string, FailedMessageDraft>();
const latestUsageMemory = new Map<string, LatestUsage>();

const SAFE_SETTINGS_KEYS: readonly (keyof Settings)[] = [
    'schemaVersion',
    'viewInline',
    'expandTodos',
    'showLineNumbers',
    'showLineNumbersInToolViews',
    'wrapLinesInDiffs',
    'diffStyle',
    'analyticsOptOut',
    'analyticsConsentVersion',
    'fileViewerEnabled',
    'sidebarLeftJustified',
    'alwaysShowContextSize',
    'agentInputEnterToSend',
    'avatarStyle',
    'showFlavorIcons',
    'compactSessionView',
    'hideInactiveSessions',
    'expResumeSession',
    'fileDiffsSidebar',
    'groupToolCalls',
    'expImageUpload',
    'reviewPromptAnswered',
    'reviewPromptLikedApp',
    'voiceAssistantLanguage',
    'voiceBypassToken',
    'preferredLanguage',
    'lastUsedAgent',
    'lastUsedPermissionMode',
];

const SAFE_LOCAL_SETTINGS_KEYS: readonly (keyof LocalSettings)[] = [
    'commandPaletteEnabled',
    'themePreference',
    'markdownCopyV2',
    'zenMode',
    'showMessageTimestamps',
    'linksOpenIn',
    'experimentalAttachments',
    'commitAttribution',
];

/**
 * Replay fences contain session identifiers and must only be stored as an
 * authenticated ciphertext produced by the account encryption key.
 */
export function loadSessionReplayFenceCiphertext(): string | null {
    return mmkv.getString(SESSION_REPLAY_FENCE_CIPHERTEXT_KEY) ?? null;
}

export function saveSessionReplayFenceCiphertext(ciphertext: string): void {
    mmkv.set(SESSION_REPLAY_FENCE_CIPHERTEXT_KEY, ciphertext);
}

function pickKeys<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
    const result: Partial<T> = {};
    for (const key of keys) {
        result[key] = value[key];
    }
    return result;
}

function shredLegacySensitiveValues(): void {
    const exactKeys = new Set([
        'session-drafts',
        NEW_SESSION_DRAFT_KEY,
        'profile',
        'settings',
        'pending-settings',
        'local-settings',
        'session-permission-modes',
        'session-model-modes',
        'session-effort-levels',
    ]);

    try {
        for (const key of mmkv.getAllKeys()) {
            if (
                exactKeys.has(key)
                || key.startsWith('temp_text_')
                || key.startsWith('session-failed-message-v1:')
                || key.startsWith('session-latest-usage-v1:')
            ) {
                mmkv.delete(key);
            }
        }
    } catch {
        // A storage failure must not reintroduce a plaintext write path.
    }
}

shredLegacySensitiveValues();

export type NewSessionAgentType = 'claude' | 'codex' | 'gemini' | 'openclaw';
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey;
    modelMode: string;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    updatedAt: number;
}

export function loadSettings(): { settings: Settings, version: number | null } {
    if (settingsMemory) {
        return { settings: settingsParse(settingsMemory.settings), version: settingsMemory.version };
    }

    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            settingsMemory = { settings: settingsParse(parsed.settings), version: parsed.version };
            return { settings: settingsParse(settingsMemory.settings), version: settingsMemory.version };
        } catch (e) {
            console.error('Failed to parse settings');
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    settingsMemory = { settings: settingsParse(settings), version };
    mmkv.set('settings', JSON.stringify({
        settings: pickKeys(settingsMemory.settings, SAFE_SETTINGS_KEYS),
        version,
    }));
}

export function loadPendingSettings(): Partial<Settings> {
    return SettingsSchema.partial().parse(pendingSettingsMemory);
}

export function savePendingSettings(settings: Partial<Settings>) {
    pendingSettingsMemory = SettingsSchema.partial().parse(settings);
}

export function loadLocalSettings(): LocalSettings {
    if (localSettingsMemory) {
        return localSettingsParse(localSettingsMemory);
    }

    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            localSettingsMemory = localSettingsParse(parsed);
            return localSettingsParse(localSettingsMemory);
        } catch (e) {
            console.error('Failed to parse local settings');
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    localSettingsMemory = localSettingsParse(settings);
    mmkv.set('local-settings', JSON.stringify(pickKeys(localSettingsMemory, SAFE_LOCAL_SETTINGS_KEYS)));
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    if (localSettingsMemory) {
        return localSettingsMemory.themePreference;
    }

    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePreference;
        } catch (e) {
            console.error('Failed to parse local theme preference');
            return localSettingsDefaults.themePreference;
        }
    }
    return localSettingsDefaults.themePreference;
}

export function loadPurchases(): Purchases {
    const purchases = mmkv.getString('purchases');
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases');
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    mmkv.set('purchases', JSON.stringify(purchases));
}

export function loadSessionDrafts(): Record<string, string> {
    return { ...sessionDraftsMemory };
}

export function saveSessionDrafts(drafts: Record<string, string>) {
    sessionDraftsMemory = { ...drafts };
}

export function loadNewSessionDraft(): NewSessionDraft | null {
    return newSessionDraftMemory ? { ...newSessionDraftMemory } : null;
}

export function saveNewSessionDraft(draft: NewSessionDraft) {
    newSessionDraftMemory = { ...draft };
}

export function clearNewSessionDraft() {
    newSessionDraftMemory = null;
}

export function loadSessionPermissionModes(): Record<string, string> {
    return { ...sessionPermissionModesMemory };
}

export function saveSessionPermissionModes(modes: Record<string, string>) {
    sessionPermissionModesMemory = { ...modes };
}

export function loadSessionModelModes(): Record<string, string> {
    return { ...sessionModelModesMemory };
}

export function saveSessionModelModes(modes: Record<string, string>) {
    sessionModelModesMemory = { ...modes };
}

export function loadSessionEffortLevels(): Record<string, string> {
    return { ...sessionEffortLevelsMemory };
}

export function saveSessionEffortLevels(levels: Record<string, string>) {
    sessionEffortLevelsMemory = { ...levels };
}

export function loadProfile(): Profile {
    return profileParse(profileMemory);
}

export function saveProfile(profile: Profile) {
    profileMemory = profileParse(profile);
}

export function storeTempText(content: string): string {
    if (content.length > MAX_TEMP_TEXT_LENGTH) {
        throw new Error('Temporary text is too large');
    }

    const now = Date.now();
    for (const [key, value] of tempTextMemory) {
        if (value.expiresAt <= now) {
            tempTextMemory.delete(key);
        }
    }
    while (tempTextMemory.size >= MAX_TEMP_TEXT_ENTRIES) {
        const oldest = tempTextMemory.keys().next().value;
        if (typeof oldest !== 'string') break;
        tempTextMemory.delete(oldest);
    }

    const id = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    tempTextMemory.set(id, { content, expiresAt: now + TEMP_TEXT_TTL_MS });
    return id;
}

export function retrieveTempText(id: string): string | null {
    const value = tempTextMemory.get(id);
    tempTextMemory.delete(id);
    if (value && value.expiresAt > Date.now()) {
        return value.content;
    }
    return null;
}

export function getVoiceSoftPaywallShownCount(): number {
    return mmkv.getNumber(VOICE_SOFT_PAYWALL_SHOWN_KEY) ?? 0;
}

export function incrementVoiceSoftPaywallShown() {
    mmkv.set(VOICE_SOFT_PAYWALL_SHOWN_KEY, getVoiceSoftPaywallShownCount() + 1);
}

export function getVoiceOnboardingPromptLoadCount(): number {
    return mmkv.getNumber(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY) ?? 0;
}

export function incrementVoiceOnboardingPromptLoadCount() {
    mmkv.set(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY, getVoiceOnboardingPromptLoadCount() + 1);
}

export function getVoiceMessageCount(): number {
    return mmkv.getNumber(VOICE_MESSAGE_COUNT_KEY) ?? 0;
}

export function incrementVoiceMessageCount() {
    mmkv.set(VOICE_MESSAGE_COUNT_KEY, getVoiceMessageCount() + 1);
}

export function getVoiceLocalCounters() {
    return {
        softPaywallShownCount: getVoiceSoftPaywallShownCount(),
        onboardingPromptLoadCount: getVoiceOnboardingPromptLoadCount(),
        voiceMessageCount: getVoiceMessageCount(),
    };
}

export function resetVoiceLocalCounters() {
    mmkv.delete(VOICE_SOFT_PAYWALL_SHOWN_KEY);
    mmkv.delete(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY);
    mmkv.delete(VOICE_MESSAGE_COUNT_KEY);
}

export function clearPersistence() {
    mmkv.clearAll();
    sessionDraftsMemory = {};
    newSessionDraftMemory = null;
    profileMemory = { ...profileDefaults };
    settingsMemory = null;
    pendingSettingsMemory = {};
    localSettingsMemory = null;
    sessionPermissionModesMemory = {};
    sessionModelModesMemory = {};
    sessionEffortLevelsMemory = {};
    tempTextMemory.clear();
    failedMessageMemory.clear();
    latestUsageMemory.clear();
}

// Usage snapshots remain memory-only because session IDs are private metadata.

export function loadSessionLatestUsage(sessionId: string): LatestUsage | null {
    const usage = latestUsageMemory.get(sessionId);
    return usage ? { ...usage } : null;
}

export function saveSessionLatestUsage(sessionId: string, usage: LatestUsage): void {
    latestUsageMemory.set(sessionId, { ...usage });
}

// Failed plaintext messages remain memory-only until retried or discarded.
export function loadSessionFailedMessage(sessionId: string): FailedMessageDraft | null {
    const draft = failedMessageMemory.get(sessionId);
    return draft ? { ...draft } : null;
}

export function saveSessionFailedMessage(sessionId: string, draft: FailedMessageDraft): void {
    if (!failedMessageMemory.has(sessionId) && failedMessageMemory.size >= MAX_FAILED_MESSAGE_ENTRIES) {
        const oldest = failedMessageMemory.keys().next().value;
        if (typeof oldest === 'string') {
            failedMessageMemory.delete(oldest);
        }
    }
    failedMessageMemory.set(sessionId, { ...draft });
}

export function clearSessionFailedMessage(sessionId: string): void {
    failedMessageMemory.delete(sessionId);
}

// Lab onboarding / hint-once flags (shown once globally).
// Pure decision helpers live in components/labOnboardingPersist.ts; this
// file holds the mmkv read/write wrappers.
const LAB_ONBOARDING_KEY = 'lab-onboarding-seen-v1';
const SWIPE_REMOVED_HINT_KEY = 'swipe-removed-hint-seen-v1';
const SESSION_ACTIONS_HINT_KEY = 'session-actions-hint-seen-v1';

export function loadLabOnboardingFlag(): string | undefined {
    return mmkv.getString(LAB_ONBOARDING_KEY);
}
export function markLabOnboardingSeen(): void {
    mmkv.set(LAB_ONBOARDING_KEY, 'seen');
}

export function loadSwipeRemovedHintFlag(): string | undefined {
    return mmkv.getString(SWIPE_REMOVED_HINT_KEY);
}
export function markSwipeRemovedHintSeen(): void {
    mmkv.set(SWIPE_REMOVED_HINT_KEY, 'seen');
}

export function loadSessionActionsHintFlag(): string | undefined {
    return mmkv.getString(SESSION_ACTIONS_HINT_KEY);
}
export function markSessionActionsHintSeen(): void {
    mmkv.set(SESSION_ACTIONS_HINT_KEY, 'seen');
}
