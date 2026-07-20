import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const instance = {
        optIn: vi.fn(),
        optOut: vi.fn(),
    };
    return {
        instance,
        PostHog: vi.fn(function PostHogMock() {
            return instance;
        }),
    };
});

vi.mock('@/config', () => ({ config: { postHogKey: 'synthetic-project-key' } }));
vi.mock('posthog-react-native', () => ({ default: mocks.PostHog }));

import * as trackingModule from './tracking';

describe('tracking consent boundary', () => {
    it('does not construct a network client before explicit consent', () => {
        expect(trackingModule.tracking).toBeNull();
        expect(mocks.PostHog).not.toHaveBeenCalled();
    });

    it('constructs a minimized client only after opt-in and disables it on opt-out', () => {
        trackingModule.configureTracking(true);
        expect(mocks.PostHog).toHaveBeenCalledWith('synthetic-project-key', expect.objectContaining({
            captureAppLifecycleEvents: false,
            defaultOptIn: false,
            disableGeoip: true,
            enableSessionReplay: false,
            errorTracking: { autocapture: false },
            personProfiles: 'never',
            sendFeatureFlagEvent: false,
            setDefaultPersonProperties: false,
        }));
        expect(mocks.instance.optIn).toHaveBeenCalledOnce();
        expect(trackingModule.tracking).toBe(mocks.instance);

        trackingModule.configureTracking(false);
        expect(mocks.instance.optOut).toHaveBeenCalledOnce();
        expect(trackingModule.tracking).toBeNull();
    });
});
