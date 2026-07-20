import { Linking, Platform } from 'react-native';

/** Opens a URL in the system browser on supported web and native platforms. */
export async function openExternalUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
    }

    await Linking.openURL(url);
}
