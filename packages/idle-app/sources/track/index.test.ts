import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    capture: vi.fn(),
    configureTracking: vi.fn(),
    reset: vi.fn(),
}));

vi.mock('./tracking', () => ({
    tracking: {
        capture: mocks.capture,
        reset: mocks.reset,
    },
    configureTracking: mocks.configureTracking,
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { runtimeVersion: 'runtime-test' } } }));
vi.mock('expo-updates', () => ({ updateId: 'update-test', runtimeVersion: 'runtime-test' }));

import * as analytics from './index';
import {
    setTrackingConsent,
    trackMessageSent,
    trackPaywallError,
    trackSessionSwitched,
    trackVoiceSessionError,
    trackVoiceSessionStarted,
    trackVoiceSessionStopped,
} from './index';

describe('analytics privacy boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not expose an account-derived analytics identity API', () => {
        expect(analytics).not.toHaveProperty('initializeTracking');
    });

    it('enables and disables through the explicit consent boundary', () => {
        setTrackingConsent(false);
        expect(mocks.configureTracking).toHaveBeenCalledWith(false);

        setTrackingConsent(true);
        expect(mocks.configureTracking).toHaveBeenLastCalledWith(true);
    });

    it('records session navigation without durable IDs or exact timestamps', () => {
        trackSessionSwitched({
            id: 'sensitive-session-id',
            createdAt: 1,
            activeAt: 2,
            updatedAt: 3,
        } as never);
        expect(mocks.capture).toHaveBeenCalledWith('session_switched');
        expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain('sensitive-session-id');
    });

    it('never sends raw paywall errors', () => {
        trackPaywallError('sensitive token and filesystem path', 'voluntary_support');
        expect(mocks.capture).toHaveBeenCalledWith('paywall_error', { flow: 'voluntary_support' });
        expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain('sensitive token');
    });

    it('sends only coarse voice state and bounded counters', () => {
        trackVoiceSessionStarted({ hasPro: true, onboardingPromptLoads: 2, voiceMessages: 3 });
        trackVoiceSessionError();
        trackVoiceSessionStopped(42);

        const serialized = JSON.stringify(mocks.capture.mock.calls);
        expect(serialized).not.toMatch(/session_id|conversation_id|error.*message/i);
        expect(mocks.capture).toHaveBeenNthCalledWith(1, 'voice_session_started', {
            has_pro: true,
            onboarding_prompt_load_count: 2,
            voice_message_count: 3,
        });
        expect(mocks.capture).toHaveBeenNthCalledWith(2, 'voice_session_error');
        expect(mocks.capture).toHaveBeenNthCalledWith(3, 'voice_session_stopped', { duration_seconds: 42 });
    });

    it('keeps message analytics to enumerated non-content metadata', () => {
        trackMessageSent('chat', {
            flavor: 'claude',
            version: '0.4.13',
            startedBy: 'terminal',
            path: '/private/path',
            host: 'private-host',
        } as never);

        const properties = mocks.capture.mock.calls[0][1];
        expect(properties).not.toHaveProperty('path');
        expect(properties).not.toHaveProperty('host');
        expect(properties).not.toHaveProperty('session_id');
    });
});
