import { useState, useCallback } from 'react';
import { MMKV } from 'react-native-mmkv';
import {
    getLastViewedTitle,
    setLastViewedTitle,
    getLatestTitle
} from '@/changelog';

const mmkv = new MMKV();

export function useChangelog() {
    const latestTitle = getLatestTitle();

    const [hasUnread, setHasUnread] = useState(() => {
        const lastViewed = getLastViewedTitle();

        // A first install has neither key and starts read. The presence of the
        // version-key predecessor marks an upgrade that should show the banner.
        if (!lastViewed && latestTitle) {
            const hadOldKey = mmkv.contains('changelog-last-viewed-version');
            if (!hadOldKey) {
                setLastViewedTitle(latestTitle);
                return false;
            }
            // The version-key predecessor represents unread release notes.
            return true;
        }

        return latestTitle !== lastViewed;
    });

    const markAsRead = useCallback(() => {
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
            setHasUnread(false);
        }
    }, [latestTitle]);

    return {
        hasUnread,
        latestTitle,
        markAsRead
    };
}
