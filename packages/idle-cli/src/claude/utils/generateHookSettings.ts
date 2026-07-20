/**
 * Generate temporary settings file with Claude hooks for session tracking
 *
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    openSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 *
 * @param port - The port where Idle server is listening
 * @param authToken - Per-process bearer token for the loopback hook server
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, authToken: string): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid hook server port');
    }
    if (!authToken || authToken.length > 256) {
        throw new Error('Invalid hook server token');
    }

    const hooksDir = join(configuration.idleHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    chmodSync(hooksDir, 0o700);

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);
    const tokenPath = filepath.replace(/\.json$/, '.token');

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node ${shellQuote(forwarderScript)} ${port} ${shellQuote(tokenPath)}`;

    const settings = {
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    try {
        writeOwnerOnlyFile(tokenPath, authToken);
        writeOwnerOnlyFile(filepath, JSON.stringify(settings, null, 2));
    } catch (error) {
        try { unlinkSync(tokenPath); } catch { /* best effort */ }
        throw error;
    }
    logger.debug('[generateHookSettings] Created owner-only hook settings');

    return filepath;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function writeOwnerOnlyFile(filepath: string, contents: string): void {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const descriptor = openSync(
        filepath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
        0o600,
    );
    try {
        writeFileSync(descriptor, contents, 'utf8');
    } finally {
        closeSync(descriptor);
    }
    chmodSync(filepath, 0o600);
}

/**
 * Clean up the temporary hook settings file
 *
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    const tokenPath = filepath.replace(/\.json$/, '.token');
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
        }
        if (existsSync(tokenPath)) {
            unlinkSync(tokenPath);
        }
        logger.debug('[generateHookSettings] Cleaned up hook settings');
    } catch (error) {
        logger.debug('[generateHookSettings] Failed to clean up hook settings');
    }
}
