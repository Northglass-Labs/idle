import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('daemon orchestration diagnostic privacy', () => {
  it('preserves the authenticated control capability during heartbeat rewrites', async () => {
    const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
    const heartbeatState = source.match(
      /const updatedState: DaemonLocallyPersistedState = \{([\s\S]*?)\n\s*\};\n\s*writeDaemonState\(updatedState\);/,
    );

    expect(heartbeatState).not.toBeNull();
    expect(heartbeatState![1]).toContain('controlToken: fileState.controlToken');
  });

  it('does not follow redirects while loading sessions with the account bearer', async () => {
    const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
    const request = source.match(
      /axios\.get\(`\$\{configuration\.serverUrl\}\/v1\/sessions`, \{([\s\S]*?)\n\s*\}\);/,
    );

    expect(request).not.toBeNull();
    expect(request![1]).toContain('Authorization: `Bearer ${credentials.token}`');
    expect(request![1]).toContain('maxRedirects: 0');
  });

  it('keeps session identity, local paths, environment names, and raw failures out of logs', async () => {
    const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
    const diagnosticLines = source
      .split('\n')
      .filter((line) => line.includes('logger.'))
      .join('\n');

    expect(diagnosticLines).not.toMatch(
      /\$\{(?:sessionId|idleSessionId|directory|tmuxSessionName|sessionDesc|bundlePath|machine\.id|errorMessage|tmuxResult\.(?:sessionId|pid|error)|completedSession\.idleSessionId|idleProcess\.pid|pid)\}/,
    );
    expect(diagnosticLines).not.toMatch(/\.join\(['"], ['"]\)/);
    expect(diagnosticLines).not.toMatch(/\.message|\.stack|JSON\.stringify\(/);
    expect(diagnosticLines).not.toMatch(/,\s*(?:error|reason|promise)\s*\)/);
    expect(source).not.toContain('logger.debugLargeJson');
  });

  it('does not echo raw exceptions, paths, identifiers, or unknown agent values in control errors', async () => {
    const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');

    for (const forbidden of [
      "mkdirError.message || mkdirError",
      "error instanceof Error ? error.message : String(error)",
      'JSON.stringify(error)',
      'error instanceof Error ? error.stack : undefined',
      "errorMessage: `Failed to spawn session: ${errorMessage}`",
      "errorMessage: `Failed to resume session: ${errorMessage}`",
      "errorMessage: `Unsupported agent type: '${options.agent}'",
      "errorMessage: `Session ${idleSessionId}",
      "errorMessage: `Session webhook timeout for PID ${",
      "Unable to create directory at '${directory}'",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
