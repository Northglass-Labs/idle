import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    customAgentId: null as string | null,
    bypassToken: false,
    prompt: vi.fn(),
    push: vi.fn(),
    setCustomAgentId: vi.fn(),
    setBypassToken: vi.fn(),
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/usage/UsageBar', () => ({ UsageBar: 'UsageBar' }));
vi.mock('@/sync/storage', () => ({
    useEntitlement: () => true,
    useSettingMutable: (key: string) => {
        if (key === 'voiceAssistantLanguage') return ['en', vi.fn()];
        if (key === 'voiceCustomAgentId') return [mocks.customAgentId, mocks.setCustomAgentId];
        if (key === 'voiceBypassToken') return [mocks.bypassToken, mocks.setBypassToken];
        throw new Error(`Unexpected setting: ${key}`);
    },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));
vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
    getLanguageDisplayName: () => 'English',
}));
vi.mock('@/sync/apiVoice', () => ({ fetchVoiceUsage: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { prompt: mocks.prompt } }));
vi.mock('@/sync/sync', () => ({ sync: { presentPaywall: vi.fn() } }));
vi.mock('@/track', () => ({ trackPaywallButtonClicked: vi.fn() }));

import VoiceSettingsScreen from './app/(app)/settings/voice';

async function renderVoiceSettings() {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(React.createElement(VoiceSettingsScreen));
    });
    return renderer!;
}

function customAgentRow(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root.findAllByType('Item').find((item) => (
        item.props.title === 'settingsVoice.customAgentId'
        && typeof item.props.onPress === 'function'
    ));
}

describe('public settings hygiene', () => {
    beforeEach(() => {
        mocks.customAgentId = null;
        mocks.bypassToken = false;
        mocks.prompt.mockReset();
        mocks.push.mockReset();
        mocks.setCustomAgentId.mockReset();
        mocks.setBypassToken.mockReset();
    });

    it('keeps Lab source comments behavior-focused', () => {
        const source = readFileSync(new URL('./app/(app)/settings/lab.tsx', import.meta.url), 'utf8');

        expect(source).not.toMatch(/\bper spec\b/i);
        expect(source).not.toMatch(/obsolete local|orphan surface|existed .* before/i);
        expect(source).not.toMatch(/\bupstream\s+\d+(?:\.\d+)+/i);
    });

    it('describes an Agent ID without BYOK, billing, quota, or dashboard claims', async () => {
        const renderer = await renderVoiceSettings();
        const row = customAgentRow(renderer);

        expect(row).toBeDefined();
        expect(row!.props.longDescription).toMatch(/Agent ID is not an API key/i);
        expect(row!.props.longDescription).not.toMatch(/BYOK|bring your own key|quota|pay .*directly|Voices dashboard/i);

        await act(async () => renderer.unmount());
    });

    it('does not promise subscription or billing outcomes in localized custom-agent copy', () => {
        const copySources = [
            './text/_default.ts',
            './text/translations/ca.ts',
            './text/translations/en.ts',
            './text/translations/es.ts',
            './text/translations/it.ts',
            './text/translations/ja.ts',
            './text/translations/pl.ts',
            './text/translations/pt.ts',
            './text/translations/ru.ts',
            './text/translations/zh-Hans.ts',
            './text/translations/zh-Hant.ts',
        ];
        const unsupportedClaims = /No subscription required|No cal subscripció|No se requiere suscripción|Nessun abbonamento richiesto|サブスクリプション不要|Subskrypcja nie jest wymagana|Nenhuma assinatura necessária|Подписка не требуется|无需订阅|無需訂閱/i;

        for (const relativePath of copySources) {
            const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
            expect(source, relativePath).not.toMatch(unsupportedClaims);
        }
    });

    it('does not enable Direct Connection when an Agent ID is entered', async () => {
        mocks.prompt.mockResolvedValue('  custom-agent-123  ');
        const renderer = await renderVoiceSettings();

        await act(async () => {
            await customAgentRow(renderer)!.props.onPress();
        });

        expect(mocks.setCustomAgentId).toHaveBeenCalledWith('custom-agent-123');
        expect(mocks.setBypassToken).not.toHaveBeenCalled();

        await act(async () => renderer.unmount());
    });

    it('turns Direct Connection off when its required Agent ID is cleared', async () => {
        mocks.customAgentId = 'custom-agent-123';
        mocks.bypassToken = true;
        mocks.prompt.mockResolvedValue('   ');
        const renderer = await renderVoiceSettings();

        await act(async () => {
            await customAgentRow(renderer)!.props.onPress();
        });

        expect(mocks.setCustomAgentId).toHaveBeenCalledWith(null);
        expect(mocks.setBypassToken).toHaveBeenCalledWith(false);

        await act(async () => renderer.unmount());
    });

    it('keeps Direct Connection available only through its explicit switch', async () => {
        mocks.customAgentId = 'custom-agent-123';
        const renderer = await renderVoiceSettings();
        const directConnectionRow = renderer.root.findAllByType('Item').find((item) => (
            item.props.title === 'settingsVoice.bypassToken'
        ));

        expect(directConnectionRow).toBeDefined();
        act(() => directConnectionRow!.props.rightElement.props.onValueChange(true));

        expect(mocks.setBypassToken).toHaveBeenCalledWith(true);

        await act(async () => renderer.unmount());
    });
});
