import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('Claude diagnostic privacy', () => {
  it('keeps SDK payloads, session identifiers, and raw errors out of remote logs', async () => {
    const remote = await source('./claudeRemote.ts');
    const launcher = await source('./claudeRemoteLauncher.ts');

    for (const forbidden of [
      'Found --resume with session ID: ${startFrom}',
      'debugLargeJson(`[claudeRemote] Message ${message.type}`, message)',
      'session file to be written to disk: ${systemInit.session_id}',
      'Session file found: ${systemInit.session_id}',
      'session transcript ${systemInit.session_id}',
      "sandbox after SDK process exit.', error",
    ]) expect(remote).not.toContain(forbidden);

    for (const forbidden of [
      "detected tool use ' + c.id!",
      'previous: ${previousSessionId}, current: ${session.sessionId}',
      'Continuing existing session: ${session.sessionId}',
      'unsupported attachment (no magic-byte match): ${att.name}',
      "SDK metadata received, updating session:', metadata",
      "launch error', e",
      "terminating tool call ' + toolCallId",
    ]) expect(launcher).not.toContain(forbidden);
  });

  it('keeps remote/user content and local identity out of Claude orchestration logs', async () => {
    const run = await source('./runClaude.ts');
    for (const forbidden of [
      "debugLargeJson('[START] Idle process started', getEnvironmentInfo())",
      'Using machineId: ${machineId}',
      'existing session ${reconnectSessionId}',
      'idle session created: idle=${response.id}',
      'Reporting session ${response.id}',
      "daemon (may not be running):`, result.error",
      'historical messages from ${jsonlPath}',
      'Failed to read ${jsonlPath}:`, error',
      'hook fired: idle=${response.id} claude=${sessionId} source=${source}',
      'Session: ${response.id}',
      'Logs: ${logPath}',
      'File event received: ${ev.name}',
      'Failed to decrypt attachment: ${ev.name}',
      'Attachment decrypted: ${ev.name}',
      'Failed to download attachment: ${ev.name}',
      'Model updated from user message: ${messageModel',
      'Fallback model updated from user message: ${messageFallbackModel',
      'Allowed tools updated from user message: ${messageAllowedTools',
      'Disallowed tools updated from user message: ${messageDisallowedTools',
      'Ignoring invalid effort from user message: ${String(incoming)}',
      "debugLargeJson('[start] /compact command pushed to queue:', message)",
      "debugLargeJson('[start] /clear command pushed to queue:', message)",
      "debugLargeJson('User message pushed to queue:', message)",
      "deactivateSession during cleanup failed:', err",
      "Error during cleanup:', error",
      "Uncaught exception:', error",
      "Unhandled rejection:', reason",
    ]) expect(run).not.toContain(forbidden);
  });

  it('keeps permission, transcript, launcher, and hook payloads out of helper logs', async () => {
    const permission = await source('./utils/permissionHandler.ts');
    const scanner = await source('./utils/sessionScanner.ts');
    const localLauncher = await source('./claudeLocalLauncher.ts');
    const hookServer = await source('./utils/startHookServer.ts');

    for (const forbidden of [
      "Plan mode result received', response",
      "Failed to set permission mode via SDK:', err",
      'Permission request sent for tool call ${id}: ${toolName}',
    ]) expect(permission).not.toContain(forbidden);

    for (const forbidden of [
      'existing entries as processed from session ${opts.sessionId}',
      'uuid=${entry.message.type',
      'uuid=${entry.event.uuid}',
      'Starting watcher for session: ${p}',
      'New session: ${sessionId}',
      'Reading session file: ${expectedSessionFile}',
      'Session file not found: ${expectedSessionFile}',
      'Error processing message: ${e}',
    ]) expect(scanner).not.toContain(forbidden);

    expect(localLauncher).not.toContain("failed to send Claude transcript message', error");
    expect(localLauncher).not.toContain("launch error', e");
    expect(hookServer).not.toContain("Error handling session hook:', error");
    expect(hookServer).not.toContain("Server error:', err");
  });
});
