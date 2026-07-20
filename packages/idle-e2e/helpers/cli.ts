import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/** Monorepo root, two levels up from this helper file */
const MONOREPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Path to the CLI entry point */
const CLI_ENTRY = resolve(MONOREPO_ROOT, 'packages', 'idle-cli', 'bin', 'idle.mjs');

interface CliProcess {
    /** The underlying child process */
    process: ChildProcess;
    /** All stdout output captured so far */
    stdout: string;
    /** All stderr output captured so far */
    stderr: string;
    /** Wait for a pattern to appear in stdout within the given timeout */
    waitForOutput: (pattern: string | RegExp, timeout?: number) => Promise<string>;
    /** Kill the child process and wait for exit */
    kill: () => Promise<void>;
}

/**
 * Spawn the idle-coder CLI as a child process for E2E testing.
 *
 * Resolves the CLI entry point relative to the monorepo root so tests
 * work regardless of the working directory. Uses `node` directly with
 * the .mjs entry point (which handles its own TypeScript loading).
 *
 * @param args - CLI arguments to pass (e.g., ['daemon', 'start'])
 * @param env  - Additional environment variables (merged with process.env)
 */
export function spawnCli(args: string[] = [], env: Record<string, string> = {}): CliProcess {
    const child = spawn('node', [CLI_ENTRY, ...args], {
        env: { ...process.env, ...env },
        cwd: MONOREPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const result: CliProcess = {
        process: child,
        stdout: '',
        stderr: '',
        waitForOutput,
        kill,
    };

    child.stdout?.on('data', (data: Buffer) => {
        result.stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
        result.stderr += data.toString();
    });

    /**
     * Wait for a pattern to appear in stdout.
     * Checks existing output first, then polls on new data events.
     */
    function waitForOutput(pattern: string | RegExp, timeout = 30000): Promise<string> {
        return new Promise((resolve, reject) => {
            const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

            // Check if the pattern already appeared in captured output
            const existingMatch = result.stdout.match(regex);
            if (existingMatch) {
                resolve(existingMatch[0]);
                return;
            }

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(
                    `Timed out waiting for pattern "${pattern}" after ${timeout}ms.\n` +
                    `stdout so far:\n${result.stdout}\n` +
                    `stderr so far:\n${result.stderr}`
                ));
            }, timeout);

            function onData() {
                const match = result.stdout.match(regex);
                if (match) {
                    cleanup();
                    resolve(match[0]);
                }
            }

            function cleanup() {
                clearTimeout(timer);
                child.stdout?.off('data', onData);
            }

            child.stdout?.on('data', onData);
        });
    }

    /** Kill the child process and wait for it to fully exit */
    function kill(): Promise<void> {
        return new Promise((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }

            child.on('exit', () => resolve());
            child.kill('SIGTERM');

            // Force kill after 5 seconds if SIGTERM doesn't work
            setTimeout(() => {
                if (child.exitCode === null) {
                    child.kill('SIGKILL');
                }
            }, 5000);
        });
    }

    return result;
}
