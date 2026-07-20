import * as React from 'react';
import { Platform } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { LabOnboardingCard } from '@/components/LabOnboardingCard';
import { LabEmptyState } from '@/components/LabEmptyState';
import { LabFeedbackFooter } from '@/components/LabFeedbackFooter';
import { useRouter } from 'expo-router';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';

/** Per-feature Lab toggles grouped by product surface. */
export default function LabScreen() {
    const router = useRouter();
    // Image uploads use a synced setting so composer behavior follows the user.
    const [expImageUpload, setExpImageUpload] = useSettingMutable('expImageUpload');
    const [fileViewerEnabled, setFileViewerEnabled] = useSettingMutable('fileViewerEnabled');
    const [expResumeSession, setExpResumeSession] = useSettingMutable('expResumeSession');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    // The command palette is a web-only, device-local preference.
    const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');

    const [fileDiffsSidebar, setFileDiffsSidebar] = useSettingMutable('fileDiffsSidebar');
    const [groupToolCalls, setGroupToolCalls] = useSettingMutable('groupToolCalls');

    const noFlagsOn = !expImageUpload && !fileViewerEnabled && !expResumeSession && !hideInactiveSessions && !fileDiffsSidebar && !groupToolCalls;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <LabOnboardingCard />

            <ItemGroup title={t('lab.composer')}>
                <Item
                    title={t('lab.imageAttachmentsTitle')}
                    subtitle={t('lab.imageAttachmentsBadge')}
                    longDescription={t('lab.imageAttachmentsLongDescription')}
                    rightElement={<Switch value={!!expImageUpload} onValueChange={setExpImageUpload} />}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('lab.sessions')}>
                <Item
                    title={t('lab.fileBrowserTitle')}
                    subtitle={t('lab.fileBrowserBadge')}
                    longDescription={t('lab.fileBrowserLongDescription')}
                    rightElement={<Switch value={!!fileViewerEnabled} onValueChange={setFileViewerEnabled} />}
                    showChevron={false}
                />
                <Item
                    title={t('lab.resumeSessionTitle')}
                    subtitle={t('lab.resumeSessionBadge')}
                    longDescription={t('lab.resumeSessionLongDescription')}
                    rightElement={<Switch value={!!expResumeSession} onValueChange={setExpResumeSession} />}
                    showChevron={false}
                />
                <Item
                    title={t('lab.hideInactiveTitle')}
                    subtitle={t('lab.hideInactiveBadge')}
                    longDescription={t('lab.hideInactiveLongDescription')}
                    rightElement={<Switch value={!!hideInactiveSessions} onValueChange={setHideInactiveSessions} />}
                    showChevron={false}
                />
            </ItemGroup>

            {Platform.OS === 'web' && (
                <ItemGroup title={t('settingsFeatures.webFeatures')} footer={t('settingsFeatures.webFeaturesDescription')}>
                    <Item
                        title={t('settingsFeatures.commandPalette')}
                        subtitle={commandPaletteEnabled
                            ? t('settingsFeatures.commandPaletteEnabled')
                            : t('settingsFeatures.commandPaletteDisabled')}
                        rightElement={<Switch value={commandPaletteEnabled} onValueChange={setCommandPaletteEnabled} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            <ItemGroup title="Interface">
                <Item
                    title="File Diffs Sidebar"
                    subtitle="Show git changes next to the chat on desktop"
                    rightElement={<Switch value={!!fileDiffsSidebar} onValueChange={setFileDiffsSidebar} />}
                    showChevron={false}
                />
                <Item
                    title={t('settingsFeatures.groupToolCalls')}
                    subtitle={t('settingsFeatures.groupToolCallsSubtitle')}
                    rightElement={<Switch value={!!groupToolCalls} onValueChange={setGroupToolCalls} />}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('lab.diagnostics')}>
                <Item title={t('lab.viewUsageData')} onPress={() => router.push('/settings/usage')} />
            </ItemGroup>

            <LabEmptyState visible={noFlagsOn} />

            <LabFeedbackFooter />
        </ItemList>
    );
}
