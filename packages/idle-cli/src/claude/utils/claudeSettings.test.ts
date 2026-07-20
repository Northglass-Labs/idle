/**
 * Tests for Claude settings reading functionality
 *
 * Tests reading Claude's settings.json file and respecting the includeCoAuthoredBy setting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;
  let originalCommitAttribution: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });

    // Set environment variable to point to test directory
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;

    // Clear the in-app attribution env var so settings.json tests aren't
    // affected by it leaking in from the surrounding environment.
    originalCommitAttribution = process.env.IDLE_COMMIT_ATTRIBUTION;
    delete process.env.IDLE_COMMIT_ATTRIBUTION;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }

    if (originalCommitAttribution !== undefined) {
      process.env.IDLE_COMMIT_ATTRIBUTION = originalCommitAttribution;
    } else {
      delete process.env.IDLE_COMMIT_ATTRIBUTION;
    }

    // Clean up test directory
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  describe('readClaudeSettings', () => {
    it('returns null when settings file does not exist', () => {
      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });

    it('reads settings when file exists', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      const testSettings = { includeCoAuthoredBy: false, otherSetting: 'value' };
      writeFileSync(settingsPath, JSON.stringify(testSettings));

      const settings = readClaudeSettings();
      expect(settings).toEqual(testSettings);
    });

    it('returns null when settings file is invalid JSON', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, 'invalid json');

      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    // The default-behavior cases enforce the privacy-first rule: users who
    // never explicitly opted in
    // (no file OR file without the field) get no attribution.
    it('returns false when no settings file exists (privacy-first default)', () => {
      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns false when includeCoAuthoredBy is not set (privacy-first default)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns false when includeCoAuthoredBy is explicitly set to false', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns true when includeCoAuthoredBy is explicitly set to true (explicit opt-in)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    // An app-spawned session carries its Co-Authored-By preference through
    // IDLE_COMMIT_ATTRIBUTION, which takes precedence.
    it('returns true when IDLE_COMMIT_ATTRIBUTION is "1" (in-app toggle on)', () => {
      process.env.IDLE_COMMIT_ATTRIBUTION = '1';
      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });

    it('returns false when IDLE_COMMIT_ATTRIBUTION is "0" (in-app toggle off)', () => {
      process.env.IDLE_COMMIT_ATTRIBUTION = '0';
      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });

    it('lets IDLE_COMMIT_ATTRIBUTION override Claude settings.json', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      process.env.IDLE_COMMIT_ATTRIBUTION = '0';
      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });

    it('falls back to settings.json when IDLE_COMMIT_ATTRIBUTION is unset', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      // env var not set → terminal-session fallback path
      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });
  });
});
