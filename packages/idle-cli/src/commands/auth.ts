import chalk from 'chalk';
import axios from 'axios';
import { readCredentials, clearCredentials, clearMachineId, readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      break;
    case 'logout':
      await handleAuthLogout();
      break;
    case 'status':
      await handleAuthStatus();
      break;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('idle auth')} - Authentication management

${chalk.bold('Usage:')}
  idle auth login [--force]    Authenticate with Idle
  idle auth logout             Remove authentication and machine data
  idle auth status             Show authentication status
  idle auth help               Show this help message

${chalk.bold('Options:')}
  --force    Clear credentials, machine ID, and stop daemon before re-auth

${chalk.gray('PS: Your master secret never leaves your mobile/web device. Each CLI machine')}
${chalk.gray('receives only a derived key for per-machine encryption, so backup codes')}
${chalk.gray('cannot be displayed from the CLI.')}
`);
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const forceAuth = args.includes('--force') || args.includes('-f');

  if (forceAuth) {
    // Force authentication resets the existing local identity before pairing again.
    console.log(chalk.yellow('Force authentication requested.'));
    console.log(chalk.gray('This will:'));
    console.log(chalk.gray('  • Clear existing credentials'));
    console.log(chalk.gray('  • Clear machine ID'));
    console.log(chalk.gray('  • Stop daemon if running'));
    console.log(chalk.gray('  • Re-authenticate and register machine\n'));

    // Stop daemon if running
    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch {
      logger.debug('Daemon was not running or failed to stop');
    }

    // Clear credentials
    await clearCredentials();
    console.log(chalk.gray('✓ Cleared credentials'));

    // Clear machine ID
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared machine ID'));

    console.log('');
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth) {
    const existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds && settings?.machineId) {
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.green('✓ Machine registered'));
      console.log(chalk.gray(`  Use 'idle auth login --force' to re-authenticate`));
      return;
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }
  }

  // Perform authentication and machine setup.
  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.green(`✓ Machine ${result.machineId ? 'registered' : 'setup complete'}`));
  } catch {
    console.error(chalk.red('Authentication failed'));
    process.exit(1);
  }
}

async function handleAuthLogout(): Promise<void> {
  // "auth logout will essentially clear the private key that originally came from the phone"
  const idleDir = configuration.idleHomeDir;

  // Check if authenticated
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not currently authenticated'));
    return;
  }

  console.log(chalk.blue('This will log you out of Idle'));
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Idle again'));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to log out? (y/N): '), resolve);
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon();
        console.log(chalk.gray('Stopped daemon'));
      } catch { }

      // Remove entire idle directory (as current logout does)
      if (existsSync(idleDir)) {
        rmSync(idleDir, { recursive: true, force: true });
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "idle auth login" to authenticate again'));
    } catch {
      throw new Error('Failed to log out');
    }
  } else {
    console.log(chalk.blue('Logout cancelled'));
  }
}

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials();
  const settings = await readSettings();

  console.log(chalk.bold('\nAuthentication Status\n'));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "idle auth login" to authenticate'));
    return;
  }

  // Presence of a local token is not proof it still works. Verify it against
  // the same bounded authenticated endpoint used by daemon health checks.
  try {
    const res = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
      timeout: 5000,
      validateStatus: (status) => status < 500,
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'X-Happy-Client': `cli/${configuration.currentCliVersion}`,
      },
      maxRedirects: 0,
    });
    if (res.status === 401 || res.status === 403) {
      console.log(chalk.yellow('⚠️  Token present but rejected by the server (expired or revoked)'));
      console.log(chalk.gray('  Run "idle auth login --force" to re-authenticate'));
    } else {
      console.log(chalk.green('✓ Authenticated (token valid)'));
    }
  } catch {
    // Network failure says nothing about credential validity; report only the
    // local presence and failed verification state.
    console.log(chalk.green('✓ Credentials present'));
    console.log(chalk.gray('  (could not reach the server to verify the token — offline?)'));
  }

  // Machine status
  if (settings?.machineId) {
    console.log(chalk.green('✓ Machine registered'));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "idle auth login --force" to fix this'));
  }

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState();
    if (running) {
      console.log(chalk.green('✓ Daemon running'));
    } else {
      console.log(chalk.gray('✗ Daemon not running'));
    }
  } catch {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
