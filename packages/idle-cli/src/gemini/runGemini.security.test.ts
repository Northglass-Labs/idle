import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('runGemini diagnostic privacy', () => {
  it('keeps model output, provider errors, identifiers, and account metadata out of persistent logs', async () => {
    const source = await readFile(new URL('./runGemini.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'first 200 chars: ${truncatedResult}',
      'Retryable error on attempt ${attempt}/${MAX_RETRIES}: ${errorDetails}',
      "Found ${options.length} options in response:', options",
      'Status changed: ${msg.status}${statusDetail',
      'Error status received: ${statusDetail',
      'Tool call received: ${msg.toolName} (${msg.callId})',
      'Exec approval request received: ${callId}',
      'Patch apply begin: ${patchCallId}',
      'Patch apply end: ${patchEndCallId}',
      'New ACP session started: ${acpSessionId}',
      'ACP session started: ${acpSessionId}',
      "Error in gemini session:', error",
      "Error during session termination:', error",
      "Error while closing session', e",
      'Investigation objective received',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
