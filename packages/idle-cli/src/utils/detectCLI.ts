import os from 'node:os';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

/**
 * Returns the per-version bin directories under a tool-manager versions root.
 *
 * NVM lays out installs as `~/.nvm/versions/node/<version>/bin/`; fnm uses
 * `~/.fnm/node-versions/<version>/installation/bin/`. We can't predict the
 * installed version names, so we enumerate. Returns `[]` if the versions root
 * doesn't exist (the manager isn't installed) or is unreadable.
 */
function listVersionedBinDirs(versionsDir: string, binSubpath: string[]): string[] {
  if (!existsSync(versionsDir)) return [];
  try {
    return readdirSync(versionsDir)
      .map((v) => join(versionsDir, v, ...binSubpath))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

/**
 * The PATH to use for CLI detection.
 *
 * Detection runs inside the Idle daemon, a long-lived background process. A
 * background daemon routinely inherits a reduced PATH that omits user-local bin
 * dirs and any directory the user added via shell rc files (NVM, Volta, asdf,
 * fnm, mise, etc.). If detection trusted only the inherited PATH, `claude`
 * would be reported missing on machines where it is plainly installed via a
 * Node version manager, and the app would hide Claude from the new-session
 * picker.
 *
 * So detection runs against the inherited PATH *plus* the union of every place
 * a tool like `claude`, `codex`, or `gemini` could reasonably land:
 *
 *   Fixed dirs                                         | Catches
 *   ---------------------------------------------------|---------------------------
 *   ~/.local/bin                                       | Claude Code native installer; pipx
 *   ~/.npm-global/bin                                  | recommended npm global prefix
 *   ~/bin                                              | traditional Unix
 *   ~/.volta/bin                                       | Volta
 *   ~/.asdf/shims                                      | asdf (all versions via shim)
 *   ~/.local/share/mise/shims                          | mise (all versions via shim)
 *   ~/.cargo/bin                                       | Rust-based CLIs
 *   /opt/homebrew/bin                                  | Homebrew (Apple silicon)
 *   /usr/local/bin                                     | Homebrew (Intel) / manual installs
 *
 *   Scanned dirs (enumerate installed versions)        | Catches
 *   ---------------------------------------------------|---------------------------
 *   ~/.nvm/versions/node/<v>/bin                       | NVM (each installed version)
 *   ~/.fnm/node-versions/<v>/installation/bin          | fnm (each installed version)
 *
 * Standard dirs come first so the daemon's bare inherited PATH can't shadow a
 * user-installed tool with a system-default one.
 */
export function buildAugmentedPath(homeDir: string, currentPath: string | undefined): string {
  const fixedDirs = [
    join(homeDir, '.local', 'bin'),
    join(homeDir, '.npm-global', 'bin'),
    join(homeDir, 'bin'),
    join(homeDir, '.volta', 'bin'),
    join(homeDir, '.asdf', 'shims'),
    join(homeDir, '.local', 'share', 'mise', 'shims'),
    join(homeDir, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const versionDirs = [
    ...listVersionedBinDirs(join(homeDir, '.nvm', 'versions', 'node'), ['bin']),
    ...listVersionedBinDirs(join(homeDir, '.fnm', 'node-versions'), ['installation', 'bin']),
  ];
  return [...fixedDirs, ...versionDirs, currentPath ?? ''].filter(Boolean).join(':');
}

const DETECTABLE_COMMANDS = new Set(['claude', 'codex', 'gemini', 'openclaw']);

export function commandExistsOnPath(
  command: string,
  searchPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!DETECTABLE_COMMANDS.has(command)) return false;
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(value => value.toLowerCase())]
    : [''];

  for (const directory of (searchPath ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== 'win32') accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Continue through the remaining PATH candidates.
      }
    }
  }
  return false;
}

function commandExists(command: string): boolean {
  return commandExistsOnPath(
    command,
    buildAugmentedPath(os.homedir(), process.env.PATH),
    process.platform,
  );
}

function detectPosix(): CLIAvailability {
  const claude = commandExists('claude');
  const codex = commandExists('codex');
  const gemini = commandExists('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  const home = process.env.USERPROFILE || os.homedir();
  const searchPath = [
    join(home, '.local', 'bin'),
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
    process.env.PATH ?? '',
  ].filter(Boolean).join(';');
  const checkCommand = (name: string): boolean => commandExistsOnPath(name, searchPath, 'win32');

  const claude = checkCommand('claude');
  const codex = checkCommand('codex');
  const gemini = checkCommand('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, detectedAt: Date.now() };
}
