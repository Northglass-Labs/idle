/**
 * Doctor command implementation
 *
 * Provides bounded diagnostics without exposing local credentials, account
 * endpoints, commands, settings values, or filesystem paths.
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findAllIdleProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import packageJson from '../../package.json'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, string | boolean> {
    return {
        hasWorkingDirectoryOverride: Boolean(process.env.PWD),
        hasIdleHomeOverride: Boolean(process.env.IDLE_HOME_DIR),
        hasVariantOverride: Boolean(process.env.IDLE_VARIANT),
        hasServerOverride: Boolean(process.env.IDLE_SERVER_URL),
        hasProjectRootOverride: Boolean(process.env.IDLE_PROJECT_ROOT),
        hasNodeEnvironment: Boolean(process.env.NODE_ENV),
        debugEnabled: Boolean(process.env.DEBUG),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
    };
}

function getLogSummary(logDir: string): { total: number, daemon: number, regular: number } {
    if (!existsSync(logDir)) {
        return { total: 0, daemon: 0, regular: 0 };
    }

    try {
        const files = readdirSync(logDir).filter(file => file.endsWith('.log'));
        const daemon = files.filter(file => file.includes('daemon')).length;
        return { total: files.length, daemon, regular: files.length - daemon };
    } catch {
        return { total: 0, daemon: 0, regular: 0 };
    }
}

function printDaemonStatus(isRunning: boolean, state: Awaited<ReturnType<typeof readDaemonState>>): void {
    if (isRunning && state) {
        console.log(chalk.green('✓ Daemon is running'));
        console.log(`  Version: ${state.startedWithCliVersion}`);
        console.log(`  Control authentication: ${state.controlToken ? 'configured' : 'unavailable'}`);
    } else if (state && !isRunning) {
        console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
    } else {
        console.log(chalk.red('❌ Daemon is not running'));
    }
}

/**
 * Slim daemon status output for `idle daemon status`
 */
export async function runDoctorDaemon(): Promise<void> {
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        printDaemonStatus(isRunning, state);
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    console.log(chalk.gray('\nRun `idle doctor` for full diagnostics.\n'));
}

/**
 * Full doctor diagnostics — verbose sections first, concise useful info last
 */
export async function runDoctorCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\n🩺 Idle CLI Doctor\n'));

    // ── Verbose sections first (scroll off the top) ──

    // All Idle processes
    try {
        const allProcesses = await findAllIdleProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold('🔍 All Idle CLI Processes'));

            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': '📍 Current Process',
                    'daemon': '🤖 Daemon',
                    'daemon-version-check': '🔍 Daemon Version Check (stuck)',
                    'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                    'user-session': '👤 User Sessions',
                    'dev-daemon': '🛠️  Dev Daemon',
                    'dev-daemon-version-check': '🛠️  Dev Daemon Version Check (stuck)',
                    'dev-session': '🛠️  Dev Sessions',
                    'dev-doctor': '🛠️  Dev Doctor',
                    'dev-related': '🛠️  Dev Related',
                    'doctor': '🩺 Doctor',
                    'unknown': '❓ Unknown'
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                console.log(`  ${typeLabels[type] || type}: ${processes.length}`);
            });

            if (allProcesses.length > 1) {
                console.log(chalk.bold('\n💡 Process Management'));
                console.log(chalk.gray('To clean up runaway processes: idle doctor clean'));
            }
        } else {
            console.log(chalk.red('❌ No idle processes found'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error listing processes'));
    }

    // Log files
    console.log(chalk.bold('\n📝 Log Files'));
    const logSummary = getLogSummary(configuration.logsDir);
    if (logSummary.total > 0) {
        console.log(`  Session logs: ${logSummary.regular}`);
        console.log(`  Daemon logs: ${logSummary.daemon}`);
    } else {
        console.log(chalk.yellow('No log files found'));
    }

    // Daemon spawn diagnostics
    console.log(chalk.bold('\n🔧 Daemon Spawn Diagnostics'));
    const projectRoot = projectPath();
    const wrapperPath = join(projectRoot, 'bin', 'idle.mjs');
    const cliEntrypoint = join(projectRoot, 'dist', 'index.mjs');
    console.log(`Wrapper Exists: ${existsSync(wrapperPath) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
    console.log(`CLI Exists: ${existsSync(cliEntrypoint) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);

    // Environment variables
    console.log(chalk.bold('\n🌍 Environment Variables'));
    const env = getEnvironmentInfo();
    console.log(`Idle home override: ${env.hasIdleHomeOverride ? 'set' : 'not set'}`);
    console.log(`Server override: ${env.hasServerOverride ? 'set' : 'not set'}`);
    console.log(`Project-root override: ${env.hasProjectRootOverride ? 'set' : 'not set'}`);
    console.log(`Debug logging: ${env.debugEnabled ? 'enabled' : 'disabled'}`);
    console.log(`Node environment: ${env.hasNodeEnvironment ? 'set' : 'not set'}`);

    // Settings
    try {
        const settings = await readSettings();
        console.log(chalk.bold('\n📄 Settings'));
        console.log(chalk.green('✓ Settings loaded'));
        console.log(`  Sandbox: ${settings.sandboxConfig?.enabled === false ? 'disabled' : 'enabled'}`);
    } catch (error) {
        console.log(chalk.bold('\n📄 Settings:'));
        console.log(chalk.red('❌ Failed to read settings'));
    }

    // Support and bug reports
    console.log(chalk.bold('\n🐛 Support & Bug Reports'));
    console.log(`Report issues: ${chalk.blue('https://github.com/Northglass-Labs/idle/issues')}`);
    console.log(`Documentation: ${chalk.blue('https://northglass.io/')}`);

    // ── Concise useful info last (visible without scrolling) ──

    // Basic info
    console.log(chalk.bold('\n📋 Basic Information'));
    console.log(`Idle CLI Version: ${chalk.green(packageJson.version)}`);
    console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
    console.log(`Node.js Version: ${chalk.green(process.version)}`);

    // Configuration
    console.log(chalk.bold('\n⚙️  Configuration'));
    console.log('Idle home: configured');
    console.log('Server endpoint: configured');
    console.log('Local logs: configured');

    // Authentication
    console.log(chalk.bold('\n🔐 Authentication'));
    try {
        const credentials = await readCredentials();
        if (credentials) {
            console.log(chalk.green('✓ Authenticated (credentials found)'));
        } else {
            console.log(chalk.yellow('⚠️  Not authenticated (no credentials)'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error reading credentials'));
    }

    // Daemon status
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        printDaemonStatus(isRunning, state);
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}
