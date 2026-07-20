import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('runCodex diagnostic privacy', () => {
  it('delegates CLI preflight to the shim-aware bounded probe', async () => {
    const source = await readFile(new URL('./runCodex.ts', import.meta.url), 'utf8');

    expect(source).toContain('isCodexCliAvailable');
    expect(source).not.toContain("execSync('codex --version'");
    expect(source).not.toContain("from 'node:child_process'");
  });

  it('keeps remote metadata, provider identifiers, and raw errors out of persistent logs', async () => {
    const source = await readFile(new URL('./runCodex.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'Using machineId: ${machineId}',
      'existing session ${reconnectSessionId}',
      'Reporting session ${response.id}',
      'Reported session ${response.id}',
      "daemon (may not be running):`, result.error",
      "daemon (may not be running):', error",
      'invalid permission mode from user message: ${String(message.meta.permissionMode)}',
      'Model updated from user message: ${messageModel',
      'no model override, using current: ${currentModel',
      'invalid effort from user message: ${String(incoming)}',
      "Failed to send ready push', pushError",
      "Error during abort:', error",
      "Error disconnecting Codex during termination', e",
      "Error during session termination:', error",
      "Goal command API failed; falling back to normal turn:', error",
      "Error handling permission:', error",
      'Event received (type=${String(msg.type',
      'historical envelopes from thread ${forkCodexThreadId}',
      'Failed to read thread ${forkCodexThreadId}:`, error',
      "Error in codex session:', error",
      "Error while closing session', e",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
