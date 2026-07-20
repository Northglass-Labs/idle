import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { IdleLogoMark } from '@/brand';

/**
 * Shared header logo component used across all main tabs.
 * Extracted to prevent flickering on tab switches (each tab had its own HeaderLeft;
 * the component would unmount/remount).
 *
 * Renders the in-app Live variant of the brand mark: bars + chevron tint to the header
 * text color via currentColor; the cursor stays pinned to brand green as the "alive" signature.
 */
export const HeaderLogo = React.memo(() => {
    const { theme } = useUnistyles();
    return (
        <View style={{
            width: 38,
            height: 38,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <IdleLogoMark size={38} color={theme.colors.header.tint} />
        </View>
    );
});
