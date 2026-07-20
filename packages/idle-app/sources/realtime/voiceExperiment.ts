import { tracking } from '@/track';

export const VOICE_UPSELL_FLAG_KEY = 'voice-upsell';

export type VoiceUpsellVariant =
    | 'show-paywall-before-first-voice-chat'
    | 'voice-onboarding-and-upsell'
    | 'control';

function isVoiceUpsellVariant(value: unknown): value is Exclude<VoiceUpsellVariant, 'control'> {
    return value === 'show-paywall-before-first-voice-chat' || value === 'voice-onboarding-and-upsell';
}

export function getVoiceUpsellVariant(rawVariant: unknown = tracking?.getFeatureFlag(VOICE_UPSELL_FLAG_KEY)): VoiceUpsellVariant {
    if (isVoiceUpsellVariant(rawVariant)) {
        return rawVariant;
    }
    return 'control';
}
