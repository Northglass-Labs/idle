/**
 * Utilities for reading Claude's settings.json configuration
 *
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file from the default location
 *
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath();

    if (!existsSync(settingsPath)) {
      logger.debug('[ClaudeSettings] No Claude settings file found');
      return null;
    }

    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;

    logger.debug('[ClaudeSettings] Successfully read Claude settings');
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);

    return settings;
  } catch {
    logger.debug('[ClaudeSettings] Error reading Claude settings');
    return null;
  }
}

/**
 * Check whether Co-Authored-By lines should be included. The privacy-first
 * default is opt-out.
 *
 * Precedence:
 *   1. `IDLE_COMMIT_ATTRIBUTION` env var — set by the Idle daemon when it
 *      spawns a session from the app, carrying the user's in-app toggle
 *      choice ('1' = on, '0' = off). This is Idle's own preference:
 *      the in-app toggle never reads or writes the user's global
 *      ~/.claude/settings.json, so it can't disturb their terminal Claude Code.
 *   2. Otherwise — terminal-spawned sessions fall back to Claude's
 *      settings.json `includeCoAuthoredBy`. Missing/undefined → off.
 *
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  // 1. The Idle app's in-app toggle, passed through the daemon spawn.
  const fromApp = process.env.IDLE_COMMIT_ATTRIBUTION;
  if (fromApp === '1') {
    return true;
  }
  if (fromApp === '0') {
    return false;
  }

  // 2. Terminal sessions: Claude's settings.json. Missing → privacy-first off.
  const settings = readClaudeSettings();
  if (!settings || settings.includeCoAuthoredBy === undefined) {
    return false;
  }

  return settings.includeCoAuthoredBy;
}
