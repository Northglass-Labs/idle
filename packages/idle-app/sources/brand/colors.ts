/**
 * Idle brand color palette — Northglass dark with terminal green accent.
 * Deep blacks from northglass.io, terminal green (#32D74B) as the interactive accent.
 */
export const idleBrandColors = {
  /** Primary background — OLED-friendly true black */
  black: '#080808',
  /** Elevated surfaces */
  elevated: '#0F0F0F',
  /** Secondary surfaces */
  surface: '#141414',
  /** Hover states */
  subtle: '#1A1A1A',
  /** Disabled backgrounds, subtle dividers */
  muted: '#1F1F1F',
  /** Card borders, input borders */
  border: '#2A2A2A',
  /** Primary text, headings */
  white: '#FAFAFA',
  /** Body text */
  secondary: '#C0C0C0',
  /** Captions, timestamps */
  gray: '#888888',
  /** Disabled text */
  disabled: '#505050',
  /** Brand accent — terminal green */
  accent: '#32D74B',
  /** Pressed/muted accent */
  accentMuted: '#28A745',
  /** Subtle accent for background tints */
  accentSubtle: 'rgba(50, 215, 75, 0.12)',
} as const;

export type IdleBrandColors = typeof idleBrandColors;
