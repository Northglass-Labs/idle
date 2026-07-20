import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { useRouter } from 'expo-router';
import * as Localization from 'expo-localization';
import { useUnistyles, UnistylesRuntime } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { Appearance } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';
import { t, getLanguageNativeName, SUPPORTED_LANGUAGES } from '@/text';

// Define known avatar styles for this version of the app
type KnownAvatarStyle = 'northglass' | 'pixelated' | 'gradient' | 'brutalist';

const isKnownAvatarStyle = (style: string): style is KnownAvatarStyle => {
    return style === 'northglass' || style === 'pixelated' || style === 'gradient' || style === 'brutalist';
};

const AVATAR_STYLE_CYCLE: KnownAvatarStyle[] = ['northglass', 'gradient', 'pixelated', 'brutalist'];

export default function AppearanceSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    // viewInline / expandTodos / showLineNumbers retained in the synced
    // schema for back-compat (per sync/settings.ts § structure rules) but
    // hidden from UI — no code consumes them. The active equivalents are
    // showLineNumbersInToolViews + wrapLinesInDiffs below.
    const [showLineNumbersInToolViews, setShowLineNumbersInToolViews] = useSettingMutable('showLineNumbersInToolViews');
    const [wrapLinesInDiffs, setWrapLinesInDiffs] = useSettingMutable('wrapLinesInDiffs');
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const [alwaysShowContextSize, setAlwaysShowContextSize] = useSettingMutable('alwaysShowContextSize');
    const [avatarStyle, setAvatarStyle] = useSettingMutable('avatarStyle');
    const [showFlavorIcons, setShowFlavorIcons] = useSettingMutable('showFlavorIcons');
    const [compactSessionView, setCompactSessionView] = useSettingMutable('compactSessionView');
    // Per-device UI toggle for timestamps. Lives in localSettings (not synced)
    // because it's a purely cosmetic, device-specific preference.
    const [showMessageTimestamps, setShowMessageTimestamps] = useLocalSettingMutable('showMessageTimestamps');
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [linksOpenIn, setLinksOpenIn] = useLocalSettingMutable('linksOpenIn');
    // markdownCopyV2 controls the long-press selection sheet for chat messages.
    // The setting is device-local and defaults to the graduated markdown renderer.
    const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
    // Co-author credit is an explicit, privacy-first opt-in.
    const [commitAttribution, setCommitAttribution] = useLocalSettingMutable('commitAttribution');
    const [preferredLanguage] = useSettingMutable('preferredLanguage');

    // Ensure we have a valid style for display, defaulting to the new Northglass style
    // for unknown values (new installs land here).
    const displayStyle: KnownAvatarStyle = isKnownAvatarStyle(avatarStyle) ? avatarStyle : 'northglass';

    // Language display
    const getLanguageDisplayText = () => {
        if (preferredLanguage === null) {
            const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
            const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
            const detectedLanguageName = deviceLanguage in SUPPORTED_LANGUAGES ?
                                        getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES) :
                                        getLanguageNativeName('en');
            return `${t('settingsLanguage.automatic')} (${detectedLanguageName})`;
        } else if (preferredLanguage && preferredLanguage in SUPPORTED_LANGUAGES) {
            return getLanguageNativeName(preferredLanguage as keyof typeof SUPPORTED_LANGUAGES);
        }
        return t('settingsLanguage.automatic');
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>

            {/* Theme Settings */}
            <ItemGroup title={t('settingsAppearance.theme')} footer={t('settingsAppearance.themeDescription')}>
                <Item
                    title={t('settings.appearance')}
                    subtitle={themePreference === 'adaptive' ? t('settingsAppearance.themeDescriptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeDescriptions.light') : t('settingsAppearance.themeDescriptions.dark')}
                    longDescription="Adaptive matches your phone's appearance setting. Light or dark force a single mode regardless of what your phone does."
                    icon={<Ionicons name="contrast-outline" size={29} color={theme.colors.status.connecting} />}
                    detail={themePreference === 'adaptive' ? t('settingsAppearance.themeOptions.adaptive') : themePreference === 'light' ? t('settingsAppearance.themeOptions.light') : t('settingsAppearance.themeOptions.dark')}
                    onPress={() => {
                        const currentIndex = themePreference === 'adaptive' ? 0 : themePreference === 'light' ? 1 : 2;
                        const nextIndex = (currentIndex + 1) % 3;
                        const nextTheme = nextIndex === 0 ? 'adaptive' : nextIndex === 1 ? 'light' : 'dark';

                        // Update the setting
                        setThemePreference(nextTheme);

                        // Apply the theme change immediately
                        if (nextTheme === 'adaptive') {
                            // Enable adaptive themes and set to system theme
                            UnistylesRuntime.setAdaptiveThemes(true);
                            const systemTheme = Appearance.getColorScheme();
                            const color = systemTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        } else {
                            // Disable adaptive themes and set explicit theme
                            UnistylesRuntime.setAdaptiveThemes(false);
                            UnistylesRuntime.setTheme(nextTheme);
                            const color = nextTheme === 'dark' ? darkTheme.colors.groupped.background : lightTheme.colors.groupped.background;
                            UnistylesRuntime.setRootViewBackgroundColor(color);
                            SystemUI.setBackgroundColorAsync(color);
                        }
                    }}
                />
            </ItemGroup>

            {/* Language Settings */}
            <ItemGroup title={t('settingsLanguage.title')} footer={t('settingsLanguage.description')}>
                <Item
                    title={t('settingsLanguage.currentLanguage')}
                    icon={<Ionicons name="language-outline" size={29} color="#32D74B" />}
                    detail={getLanguageDisplayText()}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            {/* Text Settings */}
            {/* <ItemGroup title="Text" footer="Adjust text size and font preferences">
                <Item
                    title="Text Size"
                    subtitle="Make text larger or smaller"
                    icon={<Ionicons name="text-outline" size={29} color="#FF9500" />}
                    detail="Default"
                    onPress={() => { }}
                    disabled
                />
                <Item
                    title="Font"
                    subtitle="Choose your preferred font"
                    icon={<Ionicons name="text-outline" size={29} color="#FF9500" />}
                    detail="System"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}

            {/* Display Settings */}
            <ItemGroup title={t('settingsAppearance.display')} footer={t('settingsAppearance.displayDescription')}>
                <Item
                    title={t('settingsAppearance.compactSessionView')}
                    subtitle={t('settingsAppearance.compactSessionViewDescription')}
                    longDescription="Fits more sessions in the home list by reducing per-row padding. Useful if you have a lot of active sessions. Disable to give each session more breathing room."
                    icon={<Ionicons name="albums-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={compactSessionView}
                            onValueChange={setCompactSessionView}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showLineNumbersInToolViews')}
                    subtitle={t('settingsAppearance.showLineNumbersInToolViewsDescription')}
                    icon={<Ionicons name="code-working-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={showLineNumbersInToolViews}
                            onValueChange={setShowLineNumbersInToolViews}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.wrapLinesInDiffs')}
                    subtitle={t('settingsAppearance.wrapLinesInDiffsDescription')}
                    longDescription="Long code lines in diffs wrap to the next visual line instead of scrolling horizontally. Easier to read on phones; can break alignment for visual-block diffs (whitespace changes etc.)."
                    icon={<Ionicons name="return-down-forward-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={wrapLinesInDiffs}
                            onValueChange={setWrapLinesInDiffs}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.diffStyle')}
                    subtitle={t('settingsAppearance.diffStyleDescription')}
                    icon={<Ionicons name="git-compare-outline" size={29} color="#5856D6" />}
                    detail={diffStyle === 'split' ? t('settingsAppearance.diffStyleOptions.split') : t('settingsAppearance.diffStyleOptions.unified')}
                    onPress={() => setDiffStyle(diffStyle === 'unified' ? 'split' : 'unified')}
                />
                <Item
                    title={t('settingsAppearance.alwaysShowContextSize')}
                    subtitle={t('settingsAppearance.alwaysShowContextSizeDescription')}
                    icon={<Ionicons name="analytics-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={alwaysShowContextSize}
                            onValueChange={setAlwaysShowContextSize}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.avatarStyle')}
                    subtitle={t('settingsAppearance.avatarStyleDescription')}
                    icon={<Ionicons name="person-circle-outline" size={29} color="#28A745" />}
                    detail={t(`settingsAppearance.avatarOptions.${displayStyle}` as const)}
                    onPress={() => {
                        const currentIndex = AVATAR_STYLE_CYCLE.indexOf(displayStyle);
                        const nextIndex = (currentIndex + 1) % AVATAR_STYLE_CYCLE.length;
                        setAvatarStyle(AVATAR_STYLE_CYCLE[nextIndex]);
                    }}
                />
                <Item
                    title={t('settingsAppearance.showFlavorIcons')}
                    subtitle={t('settingsAppearance.showFlavorIconsDescription')}
                    icon={<Ionicons name="apps-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={showFlavorIcons}
                            onValueChange={setShowFlavorIcons}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.showMessageTimestamps')}
                    subtitle={t('settingsAppearance.showMessageTimestampsDescription')}
                    icon={<Ionicons name="time-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={showMessageTimestamps}
                            onValueChange={setShowMessageTimestamps}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.linksOpenIn')}
                    subtitle={t('settingsAppearance.linksOpenInDescription')}
                    icon={<Ionicons name="link-outline" size={29} color="#28A745" />}
                    detail={t(`settingsAppearance.linksOpenInOptions.${linksOpenIn}` as const)}
                    onPress={() => {
                        setLinksOpenIn(linksOpenIn === 'in-app' ? 'external' : 'in-app');
                    }}
                />
                <Item
                    title={t('settingsFeatures.markdownCopyV2')}
                    subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
                    icon={<Ionicons name="copy-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={markdownCopyV2}
                            onValueChange={setMarkdownCopyV2}
                        />
                    }
                />
                <Item
                    title={t('settingsAppearance.commitAttribution')}
                    subtitle={t('settingsAppearance.commitAttributionDescription')}
                    info={t('settingsAppearance.commitAttributionInfo')}
                    icon={<Ionicons name="git-commit-outline" size={29} color="#28A745" />}
                    rightElement={
                        <Switch
                            value={commitAttribution}
                            onValueChange={setCommitAttribution}
                        />
                    }
                />
                {/* <Item
                    title="Compact Mode"
                    subtitle="Reduce spacing between elements"
                    icon={<Ionicons name="contract-outline" size={29} color="#28A745" />}
                    disabled
                    rightElement={
                        <Switch
                            value={false}
                            disabled
                        />
                    }
                />
                <Item
                    title="Show Avatars"
                    subtitle="Display user and assistant avatars"
                    icon={<Ionicons name="person-circle-outline" size={29} color="#28A745" />}
                    disabled
                    rightElement={
                        <Switch
                            value={true}
                            disabled
                        />
                    }
                /> */}
            </ItemGroup>

            {/* Colors */}
            {/* <ItemGroup title="Colors" footer="Customize accent colors and highlights">
                <Item
                    title="Accent Color"
                    subtitle="Choose your accent color"
                    icon={<Ionicons name="color-palette-outline" size={29} color="#FF3B30" />}
                    detail="Blue"
                    onPress={() => { }}
                    disabled
                />
            </ItemGroup> */}
        </ItemList>
    );
}
