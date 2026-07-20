/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn as crossSpawn } from 'cross-spawn';
import { projectPath } from '@/projectPath';
import { join, resolve } from 'path';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
    maxOutputBytes?: number
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolve(join(projectPath(), 'scripts', 'ripgrep_launcher.cjs'));
    return new Promise((resolve, reject) => {
        // Use cross-spawn so `node` resolves to `node.exe` on Windows.
        const child = crossSpawn('node', [RUNNER_PATH, JSON.stringify(args)], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let outputExceeded = false;
        let outputBytes = 0;

        const capture = (current: string, data: Buffer): string => {
            if (outputExceeded) return current;
            outputBytes += data.byteLength;
            if (options?.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
                outputExceeded = true;
                child.kill();
                return current;
            }
            return current + data.toString();
        };

        child.stdout.on('data', (data) => {
            stdout = capture(stdout, data);
        });

        child.stderr.on('data', (data) => {
            stderr = capture(stderr, data);
        });

        child.on('close', (code) => {
            if (outputExceeded) {
                resolve({
                    exitCode: 1,
                    stdout: '',
                    stderr: 'Ripgrep output exceeded limit',
                });
                return;
            }
            resolve({
                exitCode: code || 0,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}
