import * as React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { tabInboxSvg, tabSessionsSvg, tabSettingsSvg } from './svgAssets';

export type IdleTabIconType = 'inbox' | 'sessions' | 'settings';

const svgByTab: Record<IdleTabIconType, string> = {
  inbox: tabInboxSvg,
  sessions: tabSessionsSvg,
  settings: tabSettingsSvg,
};

interface IdleTabIconProps {
  tab: IdleTabIconType;
  size?: number;
  color?: string;
}

/**
 * Idle tab bar icon (inbox, sessions, settings). Pass color from theme.
 */
export const IdleTabIcon = React.memo(({ tab, size = 24, color = '#000000' }: IdleTabIconProps) => {
  const xml = svgByTab[tab].replace(/currentColor/g, color);
  return (
    <View style={{ width: size, height: size }}>
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
});
