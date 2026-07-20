import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './systemPrompt';

describe('buildSystemPrompt', () => {
  it('appends the co-author credits when attribution is opted in', () => {
    const prompt = buildSystemPrompt(true);
    expect(prompt).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
    expect(prompt).toContain('Co-Authored-By: Idle <hello@northglass.io>');
    expect(prompt).not.toMatch(/do not append any attribution/i);
  });

  it('instructs Claude to add no attribution when opted out — the default', () => {
    // An opted-out commit must carry no trailer at all, including
    // Claude Code's own default `Co-Authored-By: Claude` / "Generated with"
    // line. Omitting the credits block is not enough — the opt-out must be
    // an explicit instruction.
    const prompt = buildSystemPrompt(false);
    expect(prompt).toMatch(/do not append any attribution/i);
    expect(prompt).not.toContain('Co-Authored-By: Idle <hello@northglass.io>');
  });

  it('always includes the base prompt regardless of attribution', () => {
    expect(buildSystemPrompt(true)).toContain('mcp__idle__change_title');
    expect(buildSystemPrompt(false)).toContain('mcp__idle__change_title');
  });
});
