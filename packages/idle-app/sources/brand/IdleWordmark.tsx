import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { FontFamilies } from '@/constants/Typography';
import { IdleLogoMark } from './IdleLogoMark';

interface IdleWordmarkProps {
  color?: string;
  fontSize?: number;
}

/**
 * Idle branded lockup: terminal prompt logo mark (live SVG, brand-green
 * cursor) + "Idle" wordmark in IBM Plex Mono Bold.
 *
 * Brand alignment:
 * - Logo: IdleLogoMark is the live SVG used throughout the tab bar and
 *   header. It keeps the cursor
 *   pinned to brand green #32D74B regardless of theme.
 * - Font: IBM Plex Mono is already loaded in the app (zero new bundle
 *   weight); its monospace form echoes the
 *   terminal-prompt glyph in the logo mark, and aligns with Northglass's
 *   monospace-in-the-mix house aesthetic.
 */
export const IdleWordmark = React.memo(({ color, fontSize = 28 }: IdleWordmarkProps) => {
  const { theme } = useUnistyles();
  const textColor = color ?? theme.colors.text;
  const iconSize = Math.round(fontSize * 1.4);
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ marginBottom: 8 }}>
        <IdleLogoMark size={iconSize} color={textColor} />
      </View>
      <Text
        style={{
          fontSize,
          fontFamily: FontFamilies.mono.semiBold,
          fontWeight: '700',
          color: textColor,
          letterSpacing: -1.5,
        }}
      >
        Idle
      </Text>
    </View>
  );
});
