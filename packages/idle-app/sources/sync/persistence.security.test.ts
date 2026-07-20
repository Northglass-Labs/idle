import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvMock = vi.hoisted(() => {
    const values = new Map<string, string | number>([
        ['session-drafts', JSON.stringify({ legacy: 'private draft' })],
        ['new-session-draft-v1', JSON.stringify({ input: 'private prompt' })],
        ['profile', JSON.stringify({ firstName: 'Private' })],
        ['settings', JSON.stringify({ settings: { inferenceOpenAIKey: 'sk-legacy-private', recentMachinePaths: [{ machineId: 'm', path: '/legacy/private' }] } })],
        ['pending-settings', JSON.stringify({ inferenceOpenAIKey: 'sk-pending-private' })],
        ['local-settings', JSON.stringify({ customSessionNames: { session: 'Private customer' } })],
        ['session-permission-modes', JSON.stringify({ 'private-session': 'danger' })],
        ['session-model-modes', JSON.stringify({ 'private-session': 'internal-model' })],
        ['session-effort-levels', JSON.stringify({ 'private-session': 'high' })],
        ['session-latest-usage-v1:private-session', JSON.stringify({ inputTokens: 1 })],
        ['temp_text_legacy', 'copied private response'],
        ['session-failed-message-v1:legacy', JSON.stringify({ text: 'failed prompt', failedAt: 1 })],
    ]);

    return {
        deletedKeys: [] as string[],
        values,
        set: vi.fn((key: string, value: string | number) => values.set(key, value)),
        delete: vi.fn((key: string) => {
            mmkvMock.deletedKeys.push(key);
            return values.delete(key);
        }),
    };
});

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) {
            const value = mmkvMock.values.get(key);
            return typeof value === 'string' ? value : undefined;
        }
        getNumber(key: string) {
            const value = mmkvMock.values.get(key);
            return typeof value === 'number' ? value : undefined;
        }
        getAllKeys() { return [...mmkvMock.values.keys()]; }
        set(key: string, value: string | number) { mmkvMock.set(key, value); }
        delete(key: string) { mmkvMock.delete(key); }
        clearAll() { mmkvMock.values.clear(); }
    },
}));

import {
    clearPersistence,
    loadNewSessionDraft,
    loadProfile,
    loadSessionDrafts,
    loadSessionFailedMessage,
    retrieveTempText,
    saveLocalSettings,
    saveNewSessionDraft,
    savePendingSettings,
    saveProfile,
    saveSessionDrafts,
    saveSessionFailedMessage,
    saveSessionLatestUsage,
    saveSessionPermissionModes,
    saveSettings,
    storeTempText,
} from './persistence';
import { localSettingsDefaults } from './localSettings';
import { profileDefaults } from './profile';
import { settingsDefaults } from './settings';

describe('sensitive local persistence boundary', () => {
    beforeEach(() => {
        mmkvMock.set.mockClear();
        mmkvMock.delete.mockClear();
        clearPersistence();
    });

    it('shreds plaintext values left by earlier releases', () => {
        expect(mmkvMock.deletedKeys).toEqual(expect.arrayContaining([
            'session-drafts',
            'new-session-draft-v1',
            'profile',
            'settings',
            'pending-settings',
            'local-settings',
            'session-permission-modes',
            'session-model-modes',
            'session-effort-levels',
            'temp_text_legacy',
            'session-failed-message-v1:legacy',
            'session-latest-usage-v1:private-session',
        ]));
    });

    it('keeps prompts, paths, profiles, copied text, and failed messages in memory only', () => {
        saveSessionDrafts({ 'session-1': 'private draft' });
        saveNewSessionDraft({
            input: 'private prompt',
            selectedMachineId: 'machine-1',
            selectedPath: '/private/customer/repository',
            agentType: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            sessionType: 'simple',
            worktreeKey: null,
            updatedAt: 1,
        });
        saveProfile({ ...profileDefaults, id: 'account-1', firstName: 'Private' });
        saveSessionFailedMessage('session-1', { text: 'failed private prompt', failedAt: 1 });
        const tempId = storeTempText('copied private response');

        expect(loadSessionDrafts()).toEqual({ 'session-1': 'private draft' });
        expect(loadNewSessionDraft()?.selectedPath).toBe('/private/customer/repository');
        expect(loadProfile().firstName).toBe('Private');
        expect(loadSessionFailedMessage('session-1')?.text).toBe('failed private prompt');
        expect(retrieveTempText(tempId)).toBe('copied private response');
        expect(retrieveTempText(tempId)).toBeNull();

        const serializedWrites = JSON.stringify(mmkvMock.set.mock.calls);
        expect(serializedWrites).not.toMatch(/private|customer|repository|prompt|response/i);
    });

    it('persists only an allowlisted non-sensitive subset of settings', () => {
        saveSettings({
            ...settingsDefaults,
            inferenceOpenAIKey: 'sk-private-api-key',
            voiceCustomAgentId: 'private-agent-id',
            recentMachinePaths: [{ machineId: 'private-machine', path: '/private/customer/repository' }],
            dismissedCLIWarnings: { perMachine: { 'private-machine': { codex: true } }, global: {} },
        }, 1);
        savePendingSettings({ inferenceOpenAIKey: 'sk-pending-private' });
        saveLocalSettings({
            ...localSettingsDefaults,
            acknowledgedCliVersions: { 'private-machine': '1.2.3' },
            customSessionNames: { 'private-session': 'Private customer project' },
        });
        saveSessionPermissionModes({ 'private-session': 'dangerously-skip-permissions' });
        saveSessionLatestUsage('private-session', {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreation: 3,
            cacheRead: 4,
            contextSize: 5,
            timestamp: 6,
        });

        const serializedWrites = JSON.stringify(mmkvMock.set.mock.calls);
        expect(serializedWrites).not.toMatch(/sk-private|private-agent|private-machine|private-session|private.customer|dangerously|\/private\//i);
    });
});
