import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { configureTracking, tracking } from './tracking';
import type { Metadata } from '@/sync/storageTypes';

// Re-export tracking for direct access
export { tracking } from './tracking';

export function setTrackingConsent(enabled: boolean) {
    configureTracking(enabled);
}

/**
 * Auth events
 */
export function trackAccountCreated() {
    tracking?.capture('account_created');
}

export function trackAccountRestored() {
    tracking?.capture('account_restored');
}

export function trackLogout() {
    tracking?.reset();
    configureTracking(false);
}

/**
 * Core user interactions
 */
export function trackConnectAttempt() {
    tracking?.capture('connect_attempt');
}

export function trackSessionSwitched(_session?: unknown) {
    tracking?.capture('session_switched');
}

export type MessageSentSource = 'chat' | 'new_session' | 'option' | 'question' | 'voice';

export function trackMessageSent(source: MessageSentSource, metadata?: Metadata | null) {
    tracking?.capture('message_sent', {
        source,
        session_agent: metadata?.flavor === 'gpt' || metadata?.flavor === 'openai'
            ? 'codex'
            : metadata?.flavor ?? null,
        session_started_source: metadata?.startedBy === 'daemon' || metadata?.startedFromDaemon === true
            ? 'daemon'
            : metadata?.startedBy === 'terminal' || metadata?.startedFromDaemon === false
                ? 'cli'
                : null,
        idle_cli_version: metadata?.version ?? null,
        ota_version: Updates.updateId ?? null,
        ota_runtime_version: Updates.runtimeVersion
            ?? (typeof Constants.expoConfig?.runtimeVersion === 'string' ? Constants.expoConfig.runtimeVersion : null),
    });
}

export function trackVoiceRecording(action: 'start' | 'stop') {
    tracking?.capture('voice_recording', { action });
}

export function trackPermissionResponse(allowed: boolean) {
    tracking?.capture('permission_response', { allowed });
}

export function trackVoicePermissionResponse(allowed: boolean) {
    tracking?.capture('voice_permission_response', { allowed });
}

type VoiceSessionStartedProperties = {
    hasPro: boolean;
    onboardingPromptLoads: number;
    voiceMessages: number;
};

function boundedCounter(value: number, maximum: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(maximum, Math.round(value)));
}

export function trackVoiceSessionStarted(properties: VoiceSessionStartedProperties) {
    tracking?.capture('voice_session_started', {
        has_pro: properties.hasPro,
        onboarding_prompt_load_count: boundedCounter(properties.onboardingPromptLoads, 100_000),
        voice_message_count: boundedCounter(properties.voiceMessages, 1_000_000),
    });
}

export function trackVoiceSessionError() {
    tracking?.capture('voice_session_error');
}

export function trackVoiceSessionStopped(durationSeconds: number | undefined) {
    if (durationSeconds === undefined) {
        tracking?.capture('voice_session_stopped');
        return;
    }
    tracking?.capture('voice_session_stopped', {
        duration_seconds: boundedCounter(durationSeconds, 24 * 60 * 60),
    });
}

/**
 * Paywall events
 */
export function trackPaywallButtonClicked(flow?: string) {
    tracking?.capture('paywall_button_clicked', flow ? { flow } : undefined);
}

export function trackPaywallPresented(flow?: string) {
    tracking?.capture('paywall_presented', flow ? { flow } : undefined);
}

export function trackPaywallPurchased(flow?: string) {
    tracking?.capture('paywall_purchased', flow ? { flow } : undefined);
}

export function trackPaywallCancelled(flow?: string) {
    tracking?.capture('paywall_cancelled', flow ? { flow } : undefined);
}

export function trackPaywallRestored(flow?: string) {
    tracking?.capture('paywall_restored', flow ? { flow } : undefined);
}

export function trackPaywallError(_error: string, flow?: string) {
    tracking?.capture('paywall_error', flow ? { flow } : undefined);
}

/**
 * Review request events
 */
export function trackReviewPromptShown() {
    tracking?.capture('review_prompt_shown');
}

export function trackReviewPromptResponse(likesApp: boolean) {
    tracking?.capture('review_prompt_response', { likes_app: likesApp });
}

export function trackReviewStoreShown() {
    tracking?.capture('review_store_shown');
}

export function trackReviewRetryScheduled(daysUntilRetry: number) {
    tracking?.capture('review_retry_scheduled', { days_until_retry: daysUntilRetry });
}

/**
 * What's New / Changelog events
 */
export function trackWhatsNewClicked() {
    tracking?.capture('whats_new_clicked');
}

export function trackGitHubConnected() {
    tracking?.capture('github_connected');
}

/**
 * OTA update events
 */
type OtaEventProperties = {
    ota_version?: string;
    ota_runtime_version?: string;
};

export function trackOtaUpdateAvailable(properties?: OtaEventProperties) {
    tracking?.capture('ota_update_available', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
}

export function trackOtaUpdateApplied(properties?: OtaEventProperties) {
    tracking?.capture('ota_update_applied', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
}
