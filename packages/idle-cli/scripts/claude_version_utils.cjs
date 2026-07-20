/**
 * Shared utilities for finding and resolving Claude Code CLI path
 * Used by both local and remote launchers
 *
 * Supports multiple installation methods:
 * 1. npm global: npm install -g @anthropic-ai/claude-code
 * 2. Homebrew: brew install claude-code
 * 3. Native installer:
 *    - macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash
 *    - PowerShell:  irm https://claude.ai/install.ps1 | iex
 *    - Windows CMD: curl -fsSL https://claude.ai/install.cmd | cmd
 * 4. PATH fallback: bun, pnpm, or any other package manager
 */

const childProcess = require('child_process');
const { execFileSync } = childProcess;
const path = require('path');
const fs = require('fs');
const os = require('os');

const testOverrides = {
    execSync: null,
    homedir: null,
};

function execSyncWithOverrides(command, options) {
    const execSyncImpl = testOverrides.execSync || childProcess.execSync;
    return execSyncImpl(command, options);
}

function getHomeDir() {
    const homedirImpl = testOverrides.homedir || os.homedir;
    return homedirImpl();
}

/**
 * Safely resolve symlink or return path if it exists
 * @param {string} filePath - Path to resolve
 * @returns {string|null} Resolved path or null if not found
 */
function resolvePathSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return fs.realpathSync(filePath);
    } catch (e) {
        // Symlink resolution failed, return original path
        return filePath;
    }
}

/**
 * Check whether a path is a JavaScript Claude entrypoint.
 * @param {string} filePath
 * @returns {boolean}
 */
function isJavaScriptEntrypoint(filePath) {
    return filePath.endsWith('.js') || filePath.endsWith('.cjs');
}

/**
 * Check whether a path is directly runnable by child_process.spawn on this platform.
 * On Unix, extensionless binaries/scripts are spawnable. On Windows, we only treat
 * `.exe` and JavaScript entrypoints as directly runnable here.
 * @param {string} filePath
 * @returns {boolean}
 */
function isRunnableClaudePath(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    if (isJavaScriptEntrypoint(filePath) || filePath.endsWith('.exe')) return true;
    return process.platform !== 'win32';
}

/**
 * Infer the package directory from a Claude CLI path when it lives inside
 * node_modules/@anthropic-ai/claude-code.
 * @param {string} filePath
 * @returns {string|null}
 */
function getClaudePackageDir(filePath) {
    if (!filePath) return null;

    const normalized = filePath.replace(/\\/g, '/');
    const marker = '/node_modules/@anthropic-ai/claude-code';
    const markerIndex = normalized.toLowerCase().indexOf(marker);
    if (markerIndex === -1) {
        return null;
    }

    return path.normalize(normalized.slice(0, markerIndex + marker.length));
}

/**
 * Resolve the Claude Code entrypoint inside a package directory.
 *
 * Prior to @anthropic-ai/claude-code@2.1.113 the package shipped a JS
 * entrypoint (`cli.js`) at the root. Starting with 2.1.113 the package
 * ships a platform-specific native binary declared in package.json `bin`
 * (e.g. `bin/claude.exe` on Windows, `bin/claude` elsewhere) and no
 * longer contains `cli.js`.
 *
 * @param {string} pkgDir - Path to the @anthropic-ai/claude-code directory
 * @returns {string|null} Path to the entrypoint, or null if not resolvable
 */
function resolveClaudeEntrypoint(pkgDir) {
    // Legacy: cli.js at package root (< 2.1.113)
    const legacyCliPath = path.join(pkgDir, 'cli.js');
    if (fs.existsSync(legacyCliPath)) {
        return legacyCliPath;
    }

    // Current: native binary declared via package.json "bin" (>= 2.1.113)
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
        return null;
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
        if (!binRel) return null;
        const binPath = path.join(pkgDir, binRel);
        if (fs.existsSync(binPath)) {
            return binPath;
        }
    } catch (e) {
        // Malformed package.json — treat as not found
    }
    return null;
}

function isPlainTextWithoutShebang(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(128);
            const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (bytesRead >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21) {
                return false;
            }
            for (let i = 0; i < bytesRead; i++) {
                const byte = buffer[i];
                const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
                const isCommonWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
                if (!isPrintableAscii && !isCommonWhitespace) {
                    return false;
                }
            }
            return bytesRead > 0;
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return false;
    }
}

/**
 * Find path to npm globally installed Claude Code CLI
 * @returns {string|null} Path to cli.js or native binary, or null if not found
 */
function findNpmGlobalCliPath() {
    try {
        const globalRoot = execSyncWithOverrides('npm root -g', { encoding: 'utf8' }).trim();
        const pkgDir = path.join(globalRoot, '@anthropic-ai', 'claude-code');
        return resolveClaudeEntrypoint(pkgDir);
    } catch (e) {
        // npm root -g failed
    }
    return null;
}

/**
 * Find Claude CLI using system PATH (which/where command)
 * Respects user's configuration and works across all platforms
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findClaudeInPath() {
    try {
        // Cross-platform: 'where' on Windows, 'which' on Unix
        const command = process.platform === 'win32' ? 'where claude' : 'which claude';
        // Suppress child output; callers represent an unavailable executable as null.
        const result = execSyncWithOverrides(command, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        const claudePath = result.split('\n')[0].trim(); // Take first match
        if (!claudePath) return null;

        // Confirm the command result exists before resolving symlinks.
        if (!fs.existsSync(claudePath)) return null;

        // Preserve the unresolved executable path when realpath resolution is unavailable.
        const resolvedPath = resolvePathSafe(claudePath) || claudePath;

        if (resolvedPath) {
            // A `.exe`-suffixed file on Unix that is plain text without a shebang is a
            // Windows npm shim checked out cross-platform — not runnable here at all.
            if (process.platform !== 'win32' && resolvedPath.endsWith('.exe') && isPlainTextWithoutShebang(resolvedPath)) {
                return null;
            }
            // On Windows, keep resolving extensionless shims to a real entrypoint.
            // On Unix, extensionless binaries/scripts are directly runnable.
            if (!isRunnableClaudePath(resolvedPath)) {
                const shimDir = path.dirname(claudePath);
                const pkgDir = path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code');
                const entrypoint = resolveClaudeEntrypoint(pkgDir);
                if (entrypoint) {
                    return { path: entrypoint, source: 'npm' };
                }

                const originalSource = detectSourceFromPath(claudePath);
                const resolvedSource = detectSourceFromPath(resolvedPath);
                if (originalSource === 'Bun' || resolvedSource === 'Bun') {
                    const bunPkgDir = path.join(getHomeDir(), '.bun', 'install', 'global', 'node_modules', '@anthropic-ai', 'claude-code');
                    const bunEntrypoint = resolveClaudeEntrypoint(bunPkgDir);
                    if (bunEntrypoint) {
                        return { path: bunEntrypoint, source: 'Bun' };
                    }
                }
                // Shim found but no resolvable entrypoint — skip and let other finders handle it
                return null;
            }

            // Detect source from BOTH original PATH entry and resolved path
            // Original path tells us HOW user accessed it (context)
            // Resolved path tells us WHERE it actually lives (content)
            const originalSource = detectSourceFromPath(claudePath);
            const resolvedSource = detectSourceFromPath(resolvedPath);

            // Prioritize original PATH entry for context (e.g., bun vs npm access)
            // Fall back to resolved path for accurate location detection
            const source = originalSource !== 'PATH' ? originalSource : resolvedSource;

            return {
                path: resolvedPath,
                source: source
            };
        }
    } catch (e) {
        // Command failed (claude not in PATH)
    }
    return null;
}

/**
 * Detect installation source from resolved path
 * Uses concrete path patterns, no assumptions
 * @param {string} resolvedPath - The resolved path to cli.js
 * @returns {string} Installation method/source
 */
function detectSourceFromPath(resolvedPath) {
    const normalized = resolvedPath.toLowerCase();
    const path = require('path');

    // Use path.normalize() for proper cross-platform path handling
    const normalizedPath = path.normalize(resolvedPath).toLowerCase();

    // Bun: ~/.bun/bin/claude -> ../node_modules/@anthropic-ai/claude-code/cli.js
    // The normalized-path checks below also cover Windows Bun installations.
    if (normalizedPath.includes('.bun') && normalizedPath.includes('bin') ||
        (normalizedPath.includes('node_modules') && normalizedPath.includes('.bun'))) {
        return 'Bun';
    }

    // Homebrew cask: hashed directories like .claude-code-2DTsDk1V (NOT npm installations)
    // Must check before general Homebrew paths to distinguish from npm-through-Homebrew
    if (normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('.claude-code-')) {
        return 'Homebrew';
    }

    // npm: clean claude-code directory (even through Homebrew's npm)
    // Windows: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code
    if (normalizedPath.includes('node_modules') && normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('claude-code') &&
        !normalizedPath.includes('.claude-code-')) {
        return 'npm';
    }

    // Windows-specific detection (detect by path patterns, not current platform)
    if (normalizedPath.includes('appdata') || normalizedPath.includes('program files') || normalizedPath.endsWith('.exe')) {
        // Windows npm
        if (normalizedPath.includes('appdata') && normalizedPath.includes('npm') && normalizedPath.includes('node_modules')) {
            return 'npm';
        }

        // Windows native installer (any location ending with claude.exe)
        if (normalizedPath.endsWith('claude.exe')) {
            return 'native installer';
        }

        // Windows native installer in AppData
        if (normalizedPath.includes('appdata') && normalizedPath.includes('claude')) {
            return 'native installer';
        }

        // Windows native installer in Program Files
        if (normalizedPath.includes('program files') && normalizedPath.includes('claude')) {
            return 'native installer';
        }
    }

    // Homebrew general paths (for non-npm installations like Cellar binaries)
    // Apple Silicon: /opt/homebrew/bin/claude
    // Intel Mac: /usr/local/bin/claude (ONLY on macOS, not Linux)
    // Linux Homebrew: /home/linuxbrew/.linuxbrew/bin/claude or ~/.linuxbrew/bin/claude
    if (normalizedPath.includes('opt/homebrew') ||
        normalizedPath.includes('usr/local/homebrew') ||
        normalizedPath.includes('home/linuxbrew') ||
        normalizedPath.includes('.linuxbrew') ||
        normalizedPath.includes('.homebrew') ||
        normalizedPath.includes('cellar') ||
        normalizedPath.includes('caskroom') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'darwin')) { // Intel Mac Homebrew default only on macOS
        return 'Homebrew';
    }

    // Native installer: standard Unix locations and ~/.local/bin
    // /usr/local/bin/claude on Linux should be native installer
    if (normalizedPath.includes('.local') && normalizedPath.includes('bin') ||
        normalizedPath.includes('.local') && normalizedPath.includes('share') && normalizedPath.includes('claude') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'linux')) { // Linux native installer
        return 'native installer';
    }

    // A PATH-resolved binary outside recognized layouts has no known installer source.
    return 'PATH';
}

/**
 * Find path to Bun globally installed Claude Code CLI
 * FIX: Check bun's bin directory, not non-existent modules directory
 * @returns {string|null} Path to cli.js or null if not found
 */
function findBunGlobalCliPath() {
    // First check if bun command exists (cross-platform)
    try {
        const bunCheckCommand = process.platform === 'win32' ? 'where bun' : 'which bun';
        execSyncWithOverrides(bunCheckCommand, { encoding: 'utf8' });
    } catch (e) {
        return null; // bun not installed
    }

    const bunBinCandidates = [
        path.join(getHomeDir(), '.bun', 'bin', 'claude'),
        path.join(getHomeDir(), '.bun', 'bin', 'claude.exe')
    ];

    // Check bun's binary directory first. Newer Claude builds resolve to a native
    // binary inside the Bun global package rather than the legacy cli.js file.
    for (const bunBin of bunBinCandidates) {
        const resolved = resolvePathSafe(bunBin);
        if (resolved && isRunnableClaudePath(resolved)) {
            return resolved;
        }
    }

    const bunPkgDir = path.join(getHomeDir(), '.bun', 'install', 'global', 'node_modules', '@anthropic-ai', 'claude-code');
    return resolveClaudeEntrypoint(bunPkgDir);
}

/**
 * Find path to Homebrew installed Claude Code CLI
 * FIX: Handle hashed directory names like .claude-code-[hash]
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findHomebrewCliPath() {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return null;
    }

    const possiblePrefixes = [
        '/opt/homebrew',
        '/usr/local',
        path.join(os.homedir(), '.linuxbrew'),
        path.join(os.homedir(), '.homebrew')
    ].filter(fs.existsSync);

    for (const prefix of possiblePrefixes) {
        // Check for binary symlink first (most reliable)
        const binPath = path.join(prefix, 'bin', 'claude');
        const resolved = resolvePathSafe(binPath);
        if (resolved && fs.existsSync(resolved)) {
            return resolved;
        }

        // Fallback: check for hashed directories in node_modules
        const nodeModulesPath = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai');
        if (fs.existsSync(nodeModulesPath)) {
            // Look for both claude-code and .claude-code-[hash]
            const entries = fs.readdirSync(nodeModulesPath);
            for (const entry of entries) {
                if (entry === 'claude-code' || entry.startsWith('.claude-code-')) {
                    const cliPath = path.join(nodeModulesPath, entry, 'cli.js');
                    if (fs.existsSync(cliPath)) {
                        return cliPath;
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Find path to native installer Claude Code CLI
 *
 * Installation locations:
 * - macOS/Linux: ~/.local/bin/claude (symlink) -> ~/.local/share/claude/versions/<version>
 * - Windows: %LOCALAPPDATA%\Claude\ or %USERPROFILE%\.claude\
 * - Legacy: ~/.claude/local/
 *
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findNativeInstallerCliPath() {
    const homeDir = getHomeDir();

    // Windows-specific locations
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

        // Check %LOCALAPPDATA%\Claude\
        const windowsClaudePath = path.join(localAppData, 'Claude');
        if (fs.existsSync(windowsClaudePath)) {
            // Check for versions directory
            const versionsDir = path.join(windowsClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }

            // Check for claude.exe directly
            const exePath = path.join(windowsClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }

            // Check for cli.js
            const cliPath = path.join(windowsClaudePath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }

        // Check %USERPROFILE%\.claude\ (alternative Windows location)
        const dotClaudePath = path.join(homeDir, '.claude');
        if (fs.existsSync(dotClaudePath)) {
            const versionsDir = path.join(dotClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }

            const exePath = path.join(dotClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
        }
    }

    // Check ~/.local/bin/claude symlink (most common location on macOS/Linux)
    const localBinPath = path.join(homeDir, '.local', 'bin', 'claude');
    const resolvedLocalBinPath = resolvePathSafe(localBinPath);
    if (resolvedLocalBinPath) return resolvedLocalBinPath;

    // Check ~/.local/share/claude/versions/ (native installer location)
    const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
    if (fs.existsSync(versionsDir)) {
        const found = findLatestVersionBinary(versionsDir);
        if (found) return found;
    }

    // Check ~/.claude/local/ (older installation method)
    const nativeBasePath = path.join(homeDir, '.claude', 'local');
    if (fs.existsSync(nativeBasePath)) {
        // Look for the cli.js in the node_modules structure
        const cliPath = path.join(nativeBasePath, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(cliPath)) {
            return cliPath;
        }

        // Alternative: direct cli.js in the installation
        const directCliPath = path.join(nativeBasePath, 'cli.js');
        if (fs.existsSync(directCliPath)) {
            return directCliPath;
        }
    }

    return null;
}

/**
 * Helper to find the latest version binary in a versions directory
 * @param {string} versionsDir - Path to versions directory
 * @param {string} [binaryName] - Optional binary name to look for inside version directory
 * @returns {string|null} Path to binary or null
 */
function findLatestVersionBinary(versionsDir, binaryName = null) {
    try {
        const entries = fs.readdirSync(versionsDir);
        if (entries.length === 0) return null;

        // Sort using semver comparison (descending)
        const sorted = entries.sort((a, b) => compareVersions(b, a));
        const latestVersion = sorted[0];
        const versionPath = path.join(versionsDir, latestVersion);

        // Check if it's a file (binary) or directory
        const stat = fs.statSync(versionPath);
        if (stat.isFile()) {
            return versionPath;
        } else if (stat.isDirectory()) {
            // If specific binary name provided, check for it
            if (binaryName) {
                const binaryPath = path.join(versionPath, binaryName);
                if (fs.existsSync(binaryPath)) {
                    return binaryPath;
                }
            }
            // Check for executable or cli.js inside directory
            const exePath = path.join(versionPath, process.platform === 'win32' ? 'claude.exe' : 'claude');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
            const cliPath = path.join(versionPath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }
    } catch (e) {
        // Directory read failed
    }
    return null;
}

/**
 * Find path to globally installed Claude Code CLI
 * Priority: IDLE_CLAUDE_PATH env var > PATH > npm > Bun > Homebrew > Native
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findGlobalClaudeCliPath() {
    // 1. Environment variable (explicit override)
    const envPath = process.env.IDLE_CLAUDE_PATH;
    if (envPath && fs.existsSync(envPath)) {
        const resolved = resolvePathSafe(envPath) || envPath;
        return { path: resolved, source: 'IDLE_CLAUDE_PATH' };
    }

    // 2. Check PATH (respects user's shell config)
    const pathResult = findClaudeInPath();
    if (pathResult) return pathResult;

    // 3. Fall back to package manager detection
    const npmPath = findNpmGlobalCliPath();
    if (npmPath) return { path: npmPath, source: 'npm' };

    const bunPath = findBunGlobalCliPath();
    if (bunPath) return { path: bunPath, source: 'Bun' };

    const homebrewPath = findHomebrewCliPath();
    if (homebrewPath) return { path: homebrewPath, source: 'Homebrew' };

    const nativePath = findNativeInstallerCliPath();
    if (nativePath) return { path: nativePath, source: 'native installer' };

    return null;
}

/**
 * Get version from Claude Code package.json
 * @param {string} cliPath - Path to cli.js
 * @returns {string|null} Version string or null
 */
function getVersion(cliPath) {
    try {
        const candidateDirs = [
            getClaudePackageDir(cliPath),
            path.dirname(cliPath),
            path.dirname(path.dirname(cliPath))
        ].filter(Boolean);

        const checked = new Set();
        for (const dir of candidateDirs) {
            if (checked.has(dir)) continue;
            checked.add(dir);

            const pkgPath = path.join(dir, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;

            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.version) {
                return pkg.version;
            }
        }
    } catch (e) {}

    try {
        const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs');
        const command = isJsFile ? process.execPath : cliPath;
        const args = isJsFile ? [cliPath, '--version'] : ['--version'];
        const output = execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
        });
        const match = output.match(/(\d+\.\d+\.\d+)/);
        return match?.[1] ?? null;
    } catch (e) {}

    return null;
}

/**
 * Compare semver versions
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    if (!a || !b) return 0;
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

const GOAL_HOOK_JSON_VALIDATION_FIXED_VERSION = '2.1.179';

function isThirdPartyAnthropicBaseUrl(value) {
    if (!value || typeof value !== 'string' || value.trim() === '') return false;
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        return hostname !== 'api.anthropic.com' && !hostname.endsWith('.anthropic.com');
    } catch (e) {
        // A malformed non-empty override is still not the default Anthropic API.
        return true;
    }
}

function shouldWarnAboutGoalHookJsonValidationRisk(version, env = process.env) {
    if (!version) return false;
    if (!isThirdPartyAnthropicBaseUrl(env.ANTHROPIC_BASE_URL)) return false;
    return compareVersions(version, GOAL_HOOK_JSON_VALIDATION_FIXED_VERSION) < 0;
}

function formatGoalHookJsonValidationWarning(version) {
    return [
        `\x1b[33mWarning:\x1b[0m Claude Code v${version} may hit /goal Stop hook JSON validation failures`,
        `with ANTHROPIC_BASE_URL backends. Upgrade Claude Code to ${GOAL_HOOK_JSON_VALIDATION_FIXED_VERSION}+`,
        'or use Idle remote mode with the bundled Claude Code runtime.'
    ].join(' ');
}

/**
 * Get the CLI path to use (global installation)
 * @returns {string} Path to cli.js
 * @throws {Error} If no global installation found
 */
function getClaudeCliPath() {
    const result = findGlobalClaudeCliPath();
    if (!result) {
        console.error('\n\x1b[1m\x1b[33mClaude Code is not installed\x1b[0m\n');
        console.error('Please install Claude Code using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended, highest priority):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @anthropic-ai/claude-code\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS/Linux):\x1b[0m');
        console.error('  \x1b[36mbrew install claude-code\x1b[0m\n');
        console.error('\x1b[1mOption 3 - Native installer:\x1b[0m');
        console.error('  \x1b[90mmacOS/Linux:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.sh | bash\x1b[0m');
        console.error('  \x1b[90mPowerShell:\x1b[0m   \x1b[36mirm https://claude.ai/install.ps1 | iex\x1b[0m');
        console.error('  \x1b[90mWindows CMD:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd\x1b[0m\n');
        console.error('\x1b[90mNote: If multiple installations exist, npm takes priority.\x1b[0m\n');
        process.exit(1);
    }

    const version = getVersion(result.path);
    const versionStr = version ? ` v${version}` : '';
    console.error(`\x1b[90mUsing Claude Code${versionStr} from ${result.source}\x1b[0m`);
    if (shouldWarnAboutGoalHookJsonValidationRisk(version)) {
        console.error(formatGoalHookJsonValidationWarning(version));
    }

    return result.path;
}

/**
 * Run Claude CLI, handling both JavaScript and binary files
 * @param {string} cliPath - Path to CLI (from getClaudeCliPath)
 */
function runClaudeCli(cliPath) {
    const { pathToFileURL } = require('url');
    // Use cross-spawn (already a dependency, used everywhere else in this repo
    // for the same reason) so Windows handles `.cmd`/`.bat`/extensionless npm
    // shims correctly instead of failing with `spawn UNKNOWN` / errno -4094.
    // For a plain `.exe` path it behaves identically to child_process.spawn.
    // This also preserves the process-launch hardening required by modern Node.
    const spawn = require('cross-spawn');


    // Check if it's a JavaScript file (.js or .cjs) or a binary file
    const isJsFile = isJavaScriptEntrypoint(cliPath);

    if (isJsFile) {
        // JavaScript file - use import to keep interceptors working
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
        return;
    }

    // Binary file (e.g., native installer >= 2.1.113, Homebrew). Spawn it as a
    // child of the launcher and act as a signal trampoline.
    //
    // CRITICAL: when the Idle CLI aborts the launcher (terminal→remote switch),
    // Node sends SIGTERM only to the immediate child (this launcher). Without
    // signal forwarding, the spawned binary becomes an orphan adopted by init
    // and *keeps reading the inherited TTY*. After a remote→local switch a
    // fresh launcher + binary is spawned, so two claude binaries end up
    // sharing the same stdin/stdout — visibly two cursors and garbled echo.
    // (Investigation: ps showed orphan claude.exe with parent pid 1 still
    // attached to the same pts as the live one.)
    const args = process.argv.slice(2);
    const child = spawn(cliPath, args, {
        stdio: 'inherit',
        env: process.env
    });

    let forwarded = false;
    const forwardAndDetach = (sig) => {
        if (forwarded) return;
        forwarded = true;
        try { child.kill(sig); } catch (_) { /* child may already be gone */ }
    };

    // Forward common termination signals to the spawned binary.
    const signalsToForward = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
    for (const sig of signalsToForward) {
        process.on(sig, () => forwardAndDetach(sig));
    }

    // Best-effort: if the launcher process is exiting for any reason and the
    // child is still alive, take it down too instead of leaving an orphan.
    process.on('exit', () => {
        if (child.exitCode === null && !child.killed) {
            try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
        }
    });

    child.on('exit', (code, signal) => {
        // Mirror the binary's exit so the Idle CLI sees the same status. If the
        // child exited because of a signal, re-raise it on ourselves so the
        // parent's child.on('exit') reports a signal exit and not a clean code.
        if (signal) {
            try {
                process.kill(process.pid, signal);
                return;
            } catch (_) {
                // Fall through to plain exit if re-raise fails.
            }
        }
        process.exit(code ?? 0);
    });

    child.on('error', (err) => {
        console.error(err);
        process.exit(1);
    });
}

function __setTestOverrides(overrides = {}) {
    testOverrides.execSync = overrides.execSync || null;
    testOverrides.homedir = overrides.homedir || null;
}

function __resetTestOverrides() {
    testOverrides.execSync = null;
    testOverrides.homedir = null;
}

module.exports = {
    findGlobalClaudeCliPath,
    findClaudeInPath,
    detectSourceFromPath,
    findNpmGlobalCliPath,
    findBunGlobalCliPath,
    findHomebrewCliPath,
    findNativeInstallerCliPath,
    getVersion,
    compareVersions,
    shouldWarnAboutGoalHookJsonValidationRisk,
    formatGoalHookJsonValidationWarning,
    GOAL_HOOK_JSON_VALIDATION_FIXED_VERSION,
    getClaudeCliPath,
    runClaudeCli,
    __setTestOverrides,
    __resetTestOverrides
};
