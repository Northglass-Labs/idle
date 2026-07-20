/**
 * Settings migration helper.
 *
 * Normalizes the legacy blanket `experiments` boolean into independent feature
 * toggles. A true legacy value enables the corresponding features; false or
 * absent values use current defaults. All unrelated keys are preserved.
 *
 * Idempotent: safe to run twice.
 */

export interface LegacySettings {
    experiments?: boolean;
    expResumeSession?: boolean;
    hideInactiveSessions?: boolean;
    analyticsOptOut?: boolean;
    [key: string]: unknown;
}

export interface ModernSettings {
    fileViewerEnabled?: boolean;
    sidebarLeftJustified?: boolean;
    expResumeSession?: boolean;
    hideInactiveSessions?: boolean;
    analyticsOptOut?: boolean;
    [key: string]: unknown;
}

export function migrateLegacySettings(legacy: LegacySettings): ModernSettings {
    const modern: ModernSettings = {};

    // Preserve every key except the dropped `experiments` flag
    for (const [key, value] of Object.entries(legacy)) {
        if (key === 'experiments') continue;
        modern[key] = value;
    }

    // Fan out experiments=true → per-feature defaults-on (only if not already set)
    if (legacy.experiments === true) {
        if (modern.fileViewerEnabled === undefined) {
            modern.fileViewerEnabled = true;
        }
        if (modern.sidebarLeftJustified === undefined) {
            modern.sidebarLeftJustified = true;
        }
    }

    return modern;
}
