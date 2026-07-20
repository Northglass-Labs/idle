import { execFileSync } from 'node:child_process';

const CLAUDE_HELP_TIMEOUT_MS = 10_000;
const CLAUDE_HELP_MAX_BYTES = 512 * 1024;

/**
 * Read Claude's help through Idle's CommonJS launcher.
 *
 * The launcher is intentionally a non-executable package asset. Invoke it with
 * the same Node runtime as Idle instead of asking the OS to execute the file.
 */
export function readClaudeHelp(launcherPath: string): string {
    return execFileSync(process.execPath, [launcherPath, '--help'], {
        encoding: 'utf8',
        maxBuffer: CLAUDE_HELP_MAX_BYTES,
        timeout: CLAUDE_HELP_TIMEOUT_MS,
        windowsHide: true,
    });
}
