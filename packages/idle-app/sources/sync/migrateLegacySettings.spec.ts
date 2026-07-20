import { describe, expect, it } from 'vitest';
import { migrateLegacySettings, type LegacySettings, type ModernSettings } from './migrateLegacySettings';

describe('migrateLegacySettings — experiments flag fan-out', () => {
    it('experiments=true expands to fileViewerEnabled=true + sidebarLeftJustified=true', () => {
        const legacy: LegacySettings = { experiments: true };
        const modern = migrateLegacySettings(legacy);
        expect(modern.fileViewerEnabled).toBe(true);
        expect(modern.sidebarLeftJustified).toBe(true);
    });

    it('experiments=false leaves new flags as undefined (defaults apply at schema layer)', () => {
        const legacy: LegacySettings = { experiments: false };
        const modern = migrateLegacySettings(legacy);
        expect(modern.fileViewerEnabled).toBeUndefined();
        expect(modern.sidebarLeftJustified).toBeUndefined();
    });

    it('experiments=undefined (never set) leaves new flags as undefined', () => {
        const legacy: LegacySettings = {};
        const modern = migrateLegacySettings(legacy);
        expect(modern.fileViewerEnabled).toBeUndefined();
        expect(modern.sidebarLeftJustified).toBeUndefined();
    });

    it('does not overwrite an explicit fileViewerEnabled=false when experiments=true', () => {
        const legacy: LegacySettings = { experiments: true, fileViewerEnabled: false };
        const modern = migrateLegacySettings(legacy);
        expect(modern.fileViewerEnabled).toBe(false);
        expect(modern.sidebarLeftJustified).toBe(true);
    });
});

describe('migrateLegacySettings — preserve other flags untouched', () => {
    it('expResumeSession preserved as-is (storage key unchanged per spec)', () => {
        const legacy: LegacySettings = { expResumeSession: true };
        const modern = migrateLegacySettings(legacy);
        expect(modern.expResumeSession).toBe(true);
    });

    it('hideInactiveSessions preserved as-is', () => {
        const legacy: LegacySettings = { hideInactiveSessions: true };
        const modern = migrateLegacySettings(legacy);
        expect(modern.hideInactiveSessions).toBe(true);
    });

    it('analyticsOptOut preserved (privacy-critical, never auto-migrate)', () => {
        const legacy: LegacySettings = { analyticsOptOut: true };
        const modern = migrateLegacySettings(legacy);
        expect(modern.analyticsOptOut).toBe(true);
    });

    it('unknown future fields preserved verbatim (forward compat)', () => {
        const legacy: LegacySettings = { futureFlag: 'value', nestedObj: { x: 1 } };
        const modern = migrateLegacySettings(legacy);
        expect(modern.futureFlag).toBe('value');
        expect(modern.nestedObj).toEqual({ x: 1 });
    });
});

describe('migrateLegacySettings — experiments flag itself is dropped', () => {
    it('removes the legacy experiments key from output (true)', () => {
        const legacy: LegacySettings = { experiments: true, expResumeSession: true };
        const modern = migrateLegacySettings(legacy);
        expect('experiments' in modern).toBe(false);
    });

    it('removes the legacy experiments key from output (false)', () => {
        const legacy: LegacySettings = { experiments: false };
        const modern = migrateLegacySettings(legacy);
        expect('experiments' in modern).toBe(false);
    });
});

describe('migrateLegacySettings — idempotent', () => {
    it('running twice produces the same result', () => {
        const legacy: LegacySettings = { experiments: true, expResumeSession: true };
        const once = migrateLegacySettings(legacy);
        const twice = migrateLegacySettings(once as unknown as LegacySettings);
        expect(twice).toEqual(once);
    });
});

describe('migrateLegacySettings — combinations', () => {
    it('experiments=true + analyticsOptOut=true + expResumeSession=true', () => {
        const legacy: LegacySettings = {
            experiments: true,
            analyticsOptOut: true,
            expResumeSession: true,
        };
        const modern = migrateLegacySettings(legacy);
        expect(modern.fileViewerEnabled).toBe(true);
        expect(modern.sidebarLeftJustified).toBe(true);
        expect(modern.analyticsOptOut).toBe(true);
        expect(modern.expResumeSession).toBe(true);
        expect('experiments' in modern).toBe(false);
    });
});
