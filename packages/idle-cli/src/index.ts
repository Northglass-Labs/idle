#!/usr/bin/env node

/**
 * CLI entry point for idle command
 *
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { runClaude, StartOptions } from '@/claude/runClaude'
import { logger } from './ui/logger'
import { clearMachineId, readCredentials, readSettings, removeLegacySessionKeyCache } from './persistence'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledIdleVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayIdleProcesses } from './daemon/doctor'
import { ApiClient } from './api/api'
import { runDoctorCommand, runDoctorDaemon } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { handleSandboxCommand } from './commands/sandbox'
import { handleServerCommand } from './commands/server'
import { spawnIdleCLI } from './utils/spawnIdleCLI'
import { claudeCliPath } from './claude/claudeLocal'
import { readClaudeHelp } from './claude/claudeHelp'
import { extractNoSandboxFlag } from './utils/sandboxFlags'
import { handleResumeCommand } from '@/resume/handleResumeCommand'
import { ensureDaemonRunning } from './daemon/ensureDaemonRunning'
import { handleCodexCommand } from './commands/codexCommand'


(async () => {
  try {
    if (await removeLegacySessionKeyCache()) {
      logger.debug('[SECURITY] Removed obsolete plaintext session-key cache')
    }
  } catch {
    logger.warn('Could not remove obsolete session-key cache; remove ~/.idle/session-key-cache.json manually')
  }

  const args = process.argv.slice(2)

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting Idle CLI', { argumentCount: args.length })
  }

  // Check if first argument is a subcommand
  const subcommand = args[0]

  // Log which subcommand was detected (for debugging)
  if (!args.includes('--version')) {
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      if (args.slice(2).some(a => a === '--help' || a === '-h')) {
        console.log(`
${chalk.bold('idle doctor clean')} - Kill all idle-related processes (daemon + sessions)

${chalk.bold('Usage:')}
  idle doctor clean

${chalk.bold('Warning:')} This is destructive — it terminates the daemon and every running session.
Conversation history is preserved on the server, but in-flight tool calls are interrupted.
`)
        process.exit(0)
      }
      const result = await killRunawayIdleProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.failed > 0) {
        console.log(`Failed to stop ${result.failed} runaway processes`)
      }
      // Reset machineId so re-registration works after account changes / 403s.
      // The "Machine registration rejected" 403 message tells users to run
      // 'idle doctor clean'; without this call, the command was a no-op for
      // that purpose and users had to hand-edit ~/.idle/settings.json.
      await clearMachineId()
      console.log('Reset machine ID (a new one will be generated on next launch)')
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'sandbox') {
    try {
      await handleSandboxCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'server') {
    try {
      await handleServerCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'bye') {
    console.log('Bye!');
    process.exit(0);
  } else if (subcommand === 'resume') {
    try {
      await handleResumeCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      await handleCodexCommand(args.slice(1));
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini subcommands
    const geminiSubcommand = args[1];

    // Handle "idle gemini model set <model>" command
    if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
      const modelName = args[3];
      const validModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

      if (!validModels.includes(modelName)) {
        console.error(`Invalid model: ${modelName}`);
        console.error(`Available models: ${validModels.join(', ')}`);
        process.exit(1);
      }

      try {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');

        const configDir = join(homedir(), '.gemini');
        const configPath = join(configDir, 'config.json');

        // Create directory if it doesn't exist
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }

        // Read existing config or create new one
        let config: any = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch (error) {
            // Ignore parse errors, start fresh
            config = {};
          }
        }

        // Update model in config
        config.model = modelName;

        // Write config back
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`✓ Model set to: ${modelName}`);
        console.log('  Configuration saved.');
        console.log(`  This model will be used in future sessions.`);
        process.exit(0);
      } catch {
        console.error('Failed to save model configuration.');
        process.exit(1);
      }
    }

    // Handle "idle gemini model get" command
    if (geminiSubcommand === 'model' && args[2] === 'get') {
      try {
        const { existsSync, readFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');

        const configPaths = [
          join(homedir(), '.gemini', 'config.json'),
          join(homedir(), '.config', 'gemini', 'config.json'),
        ];

        let model: string | null = null;
        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              model = config.model || config.GEMINI_MODEL || null;
              if (model) break;
            } catch (error) {
              // Ignore parse errors
            }
          }
        }

        if (model) {
          console.log(`Current model: ${model}`);
        } else if (process.env.GEMINI_MODEL) {
          console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`);
        } else {
          console.log('Current model: gemini-2.5-pro (default)');
        }
        process.exit(0);
      } catch {
        console.error('Failed to read model configuration.');
        process.exit(1);
      }
    }

    // Handle "idle gemini project set <project-id>" command
    if (geminiSubcommand === 'project' && args[2] === 'set' && args[3]) {
      const projectId = args[3];

      try {
        const { saveGoogleCloudProjectToConfig } = await import('@/gemini/utils/config');
        saveGoogleCloudProjectToConfig(projectId);
        console.log('✓ Google Cloud Project configured.');
        console.log(`  This project will be used for Google Workspace accounts.`);
        process.exit(0);
      } catch {
        console.error('Failed to save project configuration.');
        process.exit(1);
      }
    }

    // Handle "idle gemini project get" command
    if (geminiSubcommand === 'project' && args[2] === 'get') {
      try {
        const { readGeminiLocalConfig } = await import('@/gemini/utils/config');
        const config = readGeminiLocalConfig();

        if (config.googleCloudProject) {
          console.log('Google Cloud Project: configured.');
          if (config.googleCloudProjectEmail) {
            console.log('  Account-specific configuration: yes');
          } else {
            console.log('  Scope: all accounts');
          }
        } else if (process.env.GOOGLE_CLOUD_PROJECT) {
          console.log('Google Cloud Project: configured from environment.');
        } else {
          console.log('No Google Cloud Project configured.');
          console.log('');
          console.log('If you see "Authentication required" error, you may need to set a project:');
          console.log('  idle gemini project set <your-project-id>');
          console.log('');
          console.log('This is required for Google Workspace accounts.');
          console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
        }
        process.exit(0);
      } catch {
        console.error('Failed to read project configuration.');
        process.exit(1);
      }
    }

    // Handle "idle gemini project" (no subcommand) - show help
    if (geminiSubcommand === 'project' && !args[2]) {
      console.log('Usage: idle gemini project <command>');
      console.log('');
      console.log('Commands:');
      console.log('  set <project-id>   Set Google Cloud Project ID');
      console.log('  get                Show whether a Google Cloud Project is configured');
      console.log('');
      console.log('Google Workspace accounts require a Google Cloud Project.');
      console.log('If you see "Authentication required" error, set your project ID.');
      console.log('');
      console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
      process.exit(0);
    }

    // Handle gemini command (ACP-based agent)
    try {
      const { runGemini } = await import('@/gemini/runGemini');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let noSandbox = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--no-sandbox') {
          noSandbox = true;
        }
      }

      const {
        credentials
      } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runGemini({credentials, startedBy, noSandbox});
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'acp') {
    try {
      const { runAcp, resolveAcpAgentConfig } = await import('@/agent/acp');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      let noSandbox = false;
      const acpArgs: string[] = [];
      let customCommandMode = false;
      for (let i = 1; i < args.length; i++) {
        if (!customCommandMode && args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
          continue;
        }
        if (!customCommandMode && args[i] === '--verbose') {
          verbose = true;
          continue;
        }
        if (!customCommandMode && args[i] === '--no-sandbox') {
          noSandbox = true;
          continue;
        }
        if (args[i] === '--') {
          customCommandMode = true;
        }
        acpArgs.push(args[i]);
      }

      const resolved = resolveAcpAgentConfig(acpArgs);
      const { credentials } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runAcp({
        credentials,
        startedBy,
        verbose,
        noSandbox,
        agentName: resolved.agentName,
        command: resolved.command,
        args: resolved.args,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'openclaw') {
    try {
      const { runOpenClaw } = await import('@/openclaw/runOpenClaw');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      let gatewayUrl: string | undefined;
      let gatewayToken: string | undefined;
      let gatewayPassword: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--verbose') {
          verbose = true;
        } else if (args[i] === '--gateway-url') {
          gatewayUrl = args[++i];
        } else if (args[i] === '--gateway-token') {
          gatewayToken = args[++i];
        } else if (args[i] === '--gateway-password') {
          gatewayPassword = args[++i];
        }
      }

      const { credentials } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runOpenClaw({
        credentials,
        startedBy,
        verbose,
        gatewayUrl,
        gatewayToken,
        gatewayPassword,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "idle logout" is deprecated. Use "idle auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnIdleCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      await runDoctorDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else {
      console.log(`
${chalk.bold('idle daemon')} - Daemon management

${chalk.bold('Usage:')}
  idle daemon start              Start the daemon (detached)
  idle daemon stop               Stop the daemon (sessions stay alive)
  idle daemon status             Show daemon status
  idle daemon list               List active sessions

  If you want to kill all idle related processes run
  ${chalk.cyan('idle doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages coding-agent sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('idle doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let chromeOverride: boolean | undefined = undefined  // Track explicit --chrome or --no-chrome
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude
    const parsedSandboxFlag = extractNoSandboxFlag(args)
    options.noSandbox = parsedSandboxFlag.noSandbox
    args.length = 0
    args.push(...parsedSandboxFlag.args)

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--idle-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--model') {
        options.model = args[++i]
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else if (arg === '--js-runtime') {
        const runtime = args[++i]
        if (runtime !== 'node' && runtime !== 'bun') {
          console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`))
          process.exit(1)
        }
        options.jsRuntime = runtime
      } else if (arg === '--claude-env') {
        // Parse KEY=VALUE environment variable to pass to Claude
        const envArg = args[++i]
        if (envArg && envArg.includes('=')) {
          const eqIndex = envArg.indexOf('=')
          const key = envArg.substring(0, eqIndex)
          const value = envArg.substring(eqIndex + 1)
          options.claudeEnvVars = options.claudeEnvVars || {}
          options.claudeEnvVars[key] = value
        } else {
          console.error(chalk.red(`Invalid --claude-env format: ${envArg}. Expected KEY=VALUE`))
          process.exit(1)
        }
      } else if (arg === '--chrome') {
        chromeOverride = true
        // We'll add --chrome to claudeArgs after resolving settings default
      } else if (arg === '--no-chrome') {
        chromeOverride = false
        // Idle-specific flag to disable chrome even if default is on
      } else if (arg === '--settings') {
        // Intercept --settings flag - Idle uses this internally for session hooks
        const settingsValue = args[++i] // consume the value
        console.warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Idle for session tracking.`))
        console.warn(chalk.yellow(`   Your settings file "${settingsValue}" will be ignored.`))
        console.warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`))
        // Don't pass through to claudeArgs
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Resolve Chrome mode: explicit flag > settings > false
    const settings = await readSettings()
    const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false
    if (chromeEnabled) {
      options.claudeArgs = [...(options.claudeArgs || []), '--chrome']
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('idle')} - Remote control for coding agents

${chalk.bold('Usage:')}
  idle [options]         Start the default Claude provider with remote control
  idle auth              Manage authentication
  idle resume            Resume a previous Idle session by Idle session ID
  idle codex             Start Codex mode
  idle gemini            Start Gemini mode (ACP)
  idle openclaw          Start OpenClaw mode
  idle acp               Start a generic ACP-compatible agent
  idle connect           Local provider authentication guidance
  idle sandbox           Configure and manage OS-level sandboxing
  idle notify            Send push notification
  idle daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  idle doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  idle                    Start a Claude session with safe permission prompts
  idle resume cmmij8      Resume a previous session by Idle session ID
  idle --yolo             Dangerously skip permission checks
                            Alias for --dangerously-skip-permissions; use only
                            in an isolated workspace you trust
  idle --chrome           Enable Chrome browser access for this session
  idle --no-chrome        Disable Chrome even if default is on
  idle --no-sandbox       Disable Idle sandbox for this session
  idle --js-runtime bun   Use bun instead of node to spawn Claude Code
  idle --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                           Use a custom API endpoint (e.g., claude-code-router)
  idle acp gemini         Start Gemini via generic ACP runner
  idle acp -- opencode --acp
                           Start a custom ACP command
  idle acp opencode --verbose
                           Print raw ACP backend/envelope events
  idle auth login --force Authenticate
  idle doctor             Run diagnostics

${chalk.bold('Claude is the default provider and accepts Claude CLI passthrough options.')}
  Use Claude flags with the default idle command, for example:

  idle --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)

      // Run claude --help through the packaged CommonJS launcher.
      try {
        const claudeHelp = readClaudeHelp(claudeCliPath)
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }

      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`idle version: ${packageJson.version}`)
      return
    }

    // Normal flow - auth and machine setup
    const {
      credentials
    } = await authAndSetupMachineIfNeeded();
    await ensureDaemonRunning()

    // Start the CLI
    try {
      await runClaude(credentials, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      process.exit(1)
    }
  }
})();


/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(1)
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('idle notify')} - Send notification

${chalk.bold('Usage:')}
  idle notify -p <message> [-t <title>]    Send notification with custom message and optional title
  idle notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Idle")

${chalk.bold('Examples:')}
  idle notify -p "Deployment complete!"
  idle notify -p "System update complete" -t "Server Status"
  idle notify -t "Alert" -p "Database connection restored"
`)
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "idle notify --help" for usage information.'))
    process.exit(1)
  }

  // Load credentials
  let credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "idle auth login" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Idle"
    const notificationTitle = title || 'Idle'

    // Send the push notification
    api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

    // Give a moment for the async operation to start
    await new Promise(resolve => setTimeout(resolve, 1000))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}
