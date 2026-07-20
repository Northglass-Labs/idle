import { afterEach, describe, expect, it, vi } from 'vitest';

const sdkQuery = vi.hoisted(() => vi.fn((_params: any) => ({ sdk: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQuery,
}));

import { query } from './query';

describe('Claude SDK spawn security boundary', () => {
  const originalIdleSecret = process.env.IDLE_ADMIN_SECRET;

  afterEach(() => {
    sdkQuery.mockClear();
    if (originalIdleSecret === undefined) {
      delete process.env.IDLE_ADMIN_SECRET;
    } else {
      process.env.IDLE_ADMIN_SECRET = originalIdleSecret;
    }
  });

  it('removes unrelated host secrets while preserving explicit per-session provider variables', () => {
    process.env.IDLE_ADMIN_SECRET = 'must-not-reach-claude';

    query({
      prompt: 'hello',
      options: {
        inheritFullEnvironment: false,
        additionalEnv: {
          ANTHROPIC_API_KEY: 'explicit-provider-secret',
        },
      } as any,
    });

    const sdkOptions = sdkQuery.mock.calls[0][0].options;
    expect(sdkOptions.env.ANTHROPIC_API_KEY).toBe('explicit-provider-secret');
    expect(sdkOptions.env).not.toHaveProperty('IDLE_ADMIN_SECRET');
  });

  it('forwards the prebuilt synchronous sandbox spawn adapter to the SDK', () => {
    const spawnClaudeCodeProcess = vi.fn();

    query({
      prompt: 'hello',
      options: { spawnClaudeCodeProcess } as any,
    });

    expect(sdkQuery.mock.calls[0][0].options.spawnClaudeCodeProcess).toBe(spawnClaudeCodeProcess);
  });

  it('can disable Claude session persistence for disposable probes', () => {
    query({
      prompt: 'hello',
      options: { persistSession: false } as any,
    });

    expect(sdkQuery.mock.calls[0][0].options.persistSession).toBe(false);
  });

  it('forces protected interactive tools back through the permission callback', async () => {
    query({
      prompt: 'hello',
      options: {
        canCallTool: vi.fn(async () => ({ behavior: 'deny' as const, message: 'test' })),
      },
    });

    const preToolUse = sdkQuery.mock.calls[0][0].options.hooks?.PreToolUse;
    expect(preToolUse?.map((entry: { matcher?: string }) => entry.matcher)).toEqual([
      'AskUserQuestion',
      'ExitPlanMode',
      'exit_plan_mode',
    ]);
    for (const entry of preToolUse ?? []) {
      const output = await entry.hooks[0](
        { hook_event_name: 'PreToolUse', tool_name: entry.matcher, tool_input: {}, tool_use_id: 'tool-1' },
        'tool-1',
        { signal: new AbortController().signal },
      );
      expect(output.hookSpecificOutput).toMatchObject({
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
      });
    }
  });
});
