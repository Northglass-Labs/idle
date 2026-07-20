import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from './sessionUpdateHandlers';
import {
  handleAgentThoughtChunk,
  handleToolCall,
  handleToolCallUpdate,
} from './sessionUpdateHandlers';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function makeContext(): HandlerContext {
  return {
    transport: {
      agentName: 'test',
      getInitTimeout: () => 1,
      getToolPatterns: () => [],
      getToolCallTimeout: () => 60_000,
    },
    activeToolCalls: new Set(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: vi.fn(),
    emitIdleStatus: vi.fn(),
    clearIdleTimeout: vi.fn(),
    setIdleTimeout: vi.fn(),
  };
}

describe('ACP session update log privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('preserves provider events while keeping opaque IDs, names, and payloads out of logger calls', () => {
    const opaqueId = 'OPAQUE_TOOL_CALL_ID_36de';
    const opaqueKind = 'OPAQUE_TOOL_KIND_72c1';
    const opaquePayload = 'OPAQUE_TOOL_PAYLOAD_b4a9';
    const timestampSentinel = '2037-04-05T06:07:08.000Z';
    vi.setSystemTime(new Date(timestampSentinel));
    const context = makeContext();
    context.activeToolCalls.add(opaqueId);

    expect(handleAgentThoughtChunk({ content: { text: 'thinking' } }, context)).toEqual({ handled: true });
    expect(handleToolCallUpdate({
      status: 'pending',
      kind: opaqueKind,
      content: { command: opaquePayload },
    }, context)).toEqual({ handled: false });

    context.activeToolCalls.clear();
    expect(handleToolCall({
      toolCallId: opaqueId,
      status: 'in_progress',
      kind: opaqueKind,
      content: { command: opaquePayload },
    }, context)).toEqual({ handled: true });
    expect(handleToolCallUpdate({
      toolCallId: opaqueId,
      status: 'completed',
      kind: opaqueKind,
      content: { result: opaquePayload },
    }, context)).toEqual({ handled: true, toolCallCountSincePrompt: 0 });
    expect(handleToolCall({
      toolCallId: opaqueId,
      status: 'in_progress',
      kind: opaqueKind,
      content: { command: opaquePayload },
    }, context)).toEqual({ handled: true });
    expect(handleToolCallUpdate({
      toolCallId: opaqueId,
      status: 'failed',
      kind: opaqueKind,
      content: { error: opaquePayload },
    }, context)).toEqual({ handled: true, toolCallCountSincePrompt: 0 });

    expect(vi.mocked(context.emit)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool-call',
      toolName: opaqueKind,
      callId: opaqueId,
      args: { command: opaquePayload },
    }));
    expect(vi.mocked(context.emit)).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool-result',
      callId: opaqueId,
    }));
    const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(debugOutput).not.toContain(opaqueId);
    expect(debugOutput).not.toContain(opaqueKind);
    expect(debugOutput).not.toContain(opaquePayload);
    expect(debugOutput).not.toContain(timestampSentinel);
    expect(debugOutput).not.toContain(String(new Date(timestampSentinel).getTime()));
  });

  it('contains no persistent tool objective or timing diagnostics', async () => {
    const source = await readFile(new URL('./sessionUpdateHandlers.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'Investigation objective received',
      'new Date(startTime).toISOString()',
      'durationMinutes',
      'duration: durationStr',
      'Format duration for logging',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
