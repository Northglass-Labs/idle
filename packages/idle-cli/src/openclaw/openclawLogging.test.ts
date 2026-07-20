import { describe, expect, it } from 'vitest';
import {
  summarizeOpenClawBackendMessageForLog,
  summarizeOpenClawPromptForLog,
} from './openclawLogging';

describe('OpenClaw log redaction', () => {
  it('records prompt size without prompt content', () => {
    const secret = 'private prompt with token sk-sensitive';
    const summary = summarizeOpenClawPromptForLog(secret);
    expect(summary).toContain(String(secret.length));
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain('sk-sensitive');
  });

  it('records only the backend message type', () => {
    const secret = 'model output containing a private address';
    const summary = summarizeOpenClawBackendMessageForLog({
      type: 'model-output',
      textDelta: secret,
    });
    expect(summary).toContain('model-output');
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain('private address');
  });
});
