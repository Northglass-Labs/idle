import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiDiffProcessor } from './diffProcessor';
import { logger } from '@/ui/logger';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('GeminiDiffProcessor log privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves diff events while keeping file paths and tool identifiers out of logger calls', () => {
    const opaquePath = 'OPAQUE_INTERNAL_PATH_401e';
    const opaqueTool = 'OPAQUE_GEMINI_TOOL_62d9';
    const opaqueCallId = 'OPAQUE_CALL_ID_8ca5';
    const opaqueDiff = 'OPAQUE_DIFF_BODY_f3b7';
    const onMessage = vi.fn();
    const processor = new GeminiDiffProcessor(onMessage);

    processor.processFsEdit(opaquePath, 'private description', opaqueDiff);
    processor.processToolResult(opaqueTool, {
      path: `${opaquePath}-second`,
      diff: `${opaqueDiff}-second`,
    }, opaqueCallId);

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool-call',
      input: expect.objectContaining({ path: opaquePath, unified_diff: opaqueDiff }),
    }));
    const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(debugOutput).not.toContain(opaquePath);
    expect(debugOutput).not.toContain(opaqueTool);
    expect(debugOutput).not.toContain(opaqueCallId);
    expect(debugOutput).not.toContain(opaqueDiff);
  });
});
