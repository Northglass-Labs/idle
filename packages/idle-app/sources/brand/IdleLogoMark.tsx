import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { logoMarkLiveSvg } from './svgAssets';

interface IdleLogoMarkProps {
  size?: number;
  color?: string;
}

/**
 * Idle prompt mark (brush chevron + cursor between horizontal bars with ink splatter).
 * Use in header, favicon, app icon.
 * Pass color from theme (e.g. theme.colors.header.tint) for light/dark.
 */
export const IdleLogoMark = React.memo(({ size = 24, color = '#000000' }: IdleLogoMarkProps) => {
  // logoMarkLiveSvg has currentColor on bars + chevron and #32D74B on the cursor.
  // The replace only swaps currentColor instances; the green cursor stays green regardless of theme.
  const xml = logoMarkLiveSvg.replace(/currentColor/g, color);
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
});
