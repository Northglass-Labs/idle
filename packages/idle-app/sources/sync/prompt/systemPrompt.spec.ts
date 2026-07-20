/**
 * Tests for app system prompt
 *
 * Verifies that the system prompt contains the options XML instruction.
 */

import { describe, it, expect } from 'vitest';
import { systemPrompt } from './systemPrompt';

describe('systemPrompt', () => {
  describe('systemPrompt constant', () => {
    it('contains options XML instruction', () => {
      expect(systemPrompt).toContain('<options>');
    });

    it('contains option element instruction', () => {
      expect(systemPrompt).toContain('<option>');
    });

    it('contains plan mode section', () => {
      expect(systemPrompt).toContain('Plan mode');
    });
  });
});
