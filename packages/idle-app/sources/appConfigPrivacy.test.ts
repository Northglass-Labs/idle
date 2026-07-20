import { describe, expect, it } from 'vitest';

import configModule from '../app.config.js';

type PrivacyEntry = {
    NSPrivacyCollectedDataType: string;
    NSPrivacyCollectedDataTypeLinked: boolean;
    NSPrivacyCollectedDataTypeTracking: boolean;
    NSPrivacyCollectedDataTypePurposes: string[];
};

type AppConfigShape = {
    expo: {
        ios: {
            privacyManifests: {
                NSPrivacyTracking: boolean;
                NSPrivacyCollectedDataTypes: PrivacyEntry[];
            };
        };
    };
};

const importedConfig = configModule as unknown as AppConfigShape | { default: AppConfigShape };
const appConfig = 'expo' in importedConfig ? importedConfig : importedConfig.default;

describe('iOS privacy manifest', () => {
    it('declares every readable off-device data category used by the app', () => {
        const entries = appConfig.expo.ios.privacyManifests.NSPrivacyCollectedDataTypes;
        expect(entries.map((entry) => entry.NSPrivacyCollectedDataType).sort()).toEqual([
            'NSPrivacyCollectedDataTypeAudioData',
            'NSPrivacyCollectedDataTypeDeviceID',
            'NSPrivacyCollectedDataTypeOtherDiagnosticData',
            'NSPrivacyCollectedDataTypeOtherUserContent',
            'NSPrivacyCollectedDataTypePhotosorVideos',
            'NSPrivacyCollectedDataTypeProductInteraction',
            'NSPrivacyCollectedDataTypePurchaseHistory',
            'NSPrivacyCollectedDataTypeUserID',
        ].sort());
        expect(entries.every((entry) => entry.NSPrivacyCollectedDataTypeLinked)).toBe(true);
        expect(entries.every((entry) => !entry.NSPrivacyCollectedDataTypeTracking)).toBe(true);
        expect(entries.every((entry) => entry.NSPrivacyCollectedDataTypePurposes.length > 0)).toBe(true);
        expect(appConfig.expo.ios.privacyManifests.NSPrivacyTracking).toBe(false);
    });
});
