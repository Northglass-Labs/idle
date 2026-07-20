import { config } from '@/config';
import PostHog from 'posthog-react-native';

const analyticsDisabledByDeployment =
    process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === '1'
    || process.env.EXPO_PUBLIC_DISABLE_ANALYTICS === 'true'
    || (globalThis as any).__IDLE_CONFIG__?.disableAnalytics === true
    // Read-only compatibility with older self-host server builds.
    || (globalThis as any).__HAPPY_CONFIG__?.disableAnalytics === true;

export let tracking: PostHog | null = null;

export function configureTracking(enabled: boolean): void {
    if (!enabled || analyticsDisabledByDeployment || !config.postHogKey) {
        if (tracking) {
            tracking.optOut();
            tracking = null;
        }
        return;
    }

    if (!tracking) {
        tracking = new PostHog(config.postHogKey, {
            host: 'https://us.i.posthog.com',
            // Initial URLs can carry one-time pairing material. Lifecycle
            // autocapture is therefore forbidden even after analytics opt-in.
            captureAppLifecycleEvents: false,
            defaultOptIn: false,
            disableGeoip: true,
            enableSessionReplay: false,
            errorTracking: { autocapture: false },
            personProfiles: 'never',
            sendFeatureFlagEvent: false,
            setDefaultPersonProperties: false,
            disableSurveys: true,
            customAppProperties: properties => ({
                $app_build: properties.$app_build,
                $app_version: properties.$app_version,
                $device_type: properties.$device_type,
                $os_name: properties.$os_name,
                $os_version: properties.$os_version,
            }),
        });
    }
    tracking.optIn();
}
