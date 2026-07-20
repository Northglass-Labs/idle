import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiTransport } from './GeminiTransport';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('GeminiTransport log privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps unknown tool identifiers and input field names out of logger calls', () => {
    const opaqueToolId = 'OPAQUE_GEMINI_TOOL_ID_948b';
    const opaqueInputKey = 'OPAQUE_GEMINI_INPUT_KEY_2ed4';
    const transport = new GeminiTransport();

    const result = transport.determineToolName(
      'other',
      opaqueToolId,
      { [opaqueInputKey]: 'value' },
      { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 1 },
    );

    expect(result).toBe('other');
    const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(debugOutput).not.toContain(opaqueToolId);
    expect(debugOutput).not.toContain(opaqueInputKey);
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      '[GeminiTransport] Unknown tool pattern',
      { hasToolCallId: true, inputFieldCount: 1 },
    );
  });
});
