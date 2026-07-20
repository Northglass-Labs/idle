import chalk from 'chalk';
import {
    chmodSync,
    closeSync,
    constants as fsConstants,
    existsSync,
    fchmodSync,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require_ = createRequire(import.meta.url);

const SERVER_PACKAGE_NAME = '@northglass/idle-server';
const SETTINGS_WRITE_CONFIRM_FLAG = '--i-understand-this-will-modify-default-idle-settings';

export interface ServerOptions {
    port: number;
    host: string;
    reset: boolean;
    persistServerUrl: boolean;
    allowSettingsWrite: boolean;
}

interface ServerChildEnvironmentOptions {
    dataDir: string;
    pgliteDir: string;
    secretFile: string;
    port: number;
    host: string;
    serverUrl: string;
    staticDir?: string;
}

interface ServerArtifacts {
    /** Path to the executable (or tsx entrypoint) used to run the server. */
    command: string;
    /** Extra args (e.g. tsx + script path for source mode). */
    prefixArgs: string[];
    /** Working directory for the spawn. */
    cwd: string;
    /** Where this runnable came from. */
    source: 'package' | 'source';
    /** Static web app directory served by the self-host server. */
    webappDir?: string;
}

interface IdleServerPackageArtifact {
    command: string;
    prefixArgs?: string[];
    cwd: string;
    source?: string;
    webappDir?: string;
}

export async function handleServerCommand(args: string[]): Promise<void> {
    let opts: ServerOptions | null;
    try {
        opts = parseServerOptions(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
        showHelp();
        process.exit(1);
    }
    if (opts === null) return;

    // `idle server` owns its own stored secret. Discard ambient boot sources
    // before any long-lived CLI state or child environment can retain them.
    clearInheritedServerSecretEnvironment(process.env);

    const serverUrl = formatServerUrl(opts.host, opts.port);
    await ensureSettingsWriteAllowed(opts, serverUrl);

    const dataDir = path.join(configuration.idleHomeDir, 'server-data');
    const pgliteDir = path.join(dataDir, 'pglite');
    if (opts.reset && existsSync(dataDir)) {
        ensurePrivateServerDataDirectory(dataDir);
        console.log(chalk.yellow(`Wiping ${dataDir}...`));
        rmSync(dataDir, { recursive: true, force: true });
    }

    const artifacts = resolveServerArtifacts();
    if (!artifacts) {
        console.error(chalk.red('Could not locate the Idle server runtime.'));
        console.error(chalk.gray('  Expected one of:'));
        console.error(chalk.gray(`    - installed ${SERVER_PACKAGE_NAME} package`));
        console.error(chalk.gray('    - sibling packages/idle-server/sources/standalone.ts in the monorepo'));
        console.error(chalk.gray(`  Reinstall idle-coder, or run: npm install -g ${SERVER_PACKAGE_NAME}`));
        process.exit(1);
    }

    const staticDir = artifacts.webappDir ?? findWebappDir();

    console.log(chalk.cyan(`\n  Idle server`));
    console.log(chalk.gray(`  data dir:   ${dataDir}`));
    console.log(chalk.gray(`  server url: ${serverUrl}`));
    console.log(chalk.gray(`  mode:       ${serverArtifactMode(artifacts)}`));
    if (staticDir) {
        console.log(chalk.gray(`  webapp:     ${staticDir}`));
    } else {
        console.log(chalk.yellow('  webapp:     (no build) — API only. Build the Idle app to serve it locally.'));
    }
    console.log();

    const secretFile = ensureMasterSecretFile(dataDir);
    const env = createServerChildEnvironment(process.env, {
        dataDir,
        pgliteDir,
        secretFile,
        port: opts.port,
        host: opts.host,
        serverUrl,
        staticDir,
    });

    let activeChild: ChildProcess | undefined;
    const trackChild = (child: ChildProcess | undefined) => {
        activeChild = child;
    };
    const forwardSignal = (signal: NodeJS.Signals) => {
        if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
            activeChild.kill(signal);
            return;
        }
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    try {
        console.log(chalk.gray('Running migrations...'));
        await spawnAndWait(artifacts, env, ['migrate'], trackChild);

        if (opts.persistServerUrl) {
            // The self-hosted server serves the webapp at its own origin, so webappUrl === serverUrl.
            // Without this the CLI's auth flow would open the configured hosted webapp.
            await updateSettings(current => ({ ...current, serverUrl, webappUrl: serverUrl }));
            console.log(chalk.gray(`Wrote serverUrl + webappUrl=${serverUrl} to ${configuration.settingsFile}`));
        }

        console.log(chalk.gray('Starting server...'));
        const child = spawnBackground(artifacts, env, ['serve']);
        trackChild(child);

        console.log();
        console.log(chalk.green.bold(`✓ Idle server starting at ${serverUrl}`));
        if (staticDir) {
            console.log(chalk.green(`  Open ${serverUrl} in your browser.`));
        }
        if (opts.persistServerUrl) {
            console.log(chalk.gray('  Idle CLI + daemon will use this server automatically (settings.serverUrl).'));
        }
        console.log(chalk.gray('  Press Ctrl-C to stop.'));
        console.log();

        const result = await waitForChild(child);
        trackChild(undefined);
        const exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
        console.log(chalk.gray(`\nIdle server exited (code ${exitCode})`));
        process.exitCode = exitCode;
    } finally {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
    }
}

function optionValue(args: string[], index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || value === '-p') {
        throw new Error(`Missing value for ${option}`);
    }
    return value;
}

export function parseServerOptions(args: string[]): ServerOptions | null {
    let port = 3005;
    let host = '127.0.0.1';
    let reset = false;
    let persistServerUrl = true;
    let allowSettingsWrite = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') {
            showHelp();
            return null;
        } else if (arg === '--port' || arg === '-p') {
            const rawPort = optionValue(args, i, arg);
            i++;
            if (!/^\d+$/.test(rawPort)) {
                throw new Error('Invalid --port: expected an integer from 1 to 65535');
            }
            port = Number(rawPort);
            if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
                throw new Error('Invalid --port: expected an integer from 1 to 65535');
            }
        } else if (arg === '--host') {
            const rawHost = optionValue(args, i, arg);
            i++;
            if (rawHost.toLowerCase() === 'localhost') {
                host = 'localhost';
            } else if (isIP(rawHost) !== 0) {
                host = rawHost;
            } else {
                throw new Error('Invalid --host: expected localhost or an IPv4/IPv6 address');
            }
        } else if (arg === '--reset') {
            reset = true;
        } else if (arg === '--no-persist') {
            persistServerUrl = false;
        } else if (arg === SETTINGS_WRITE_CONFIRM_FLAG) {
            allowSettingsWrite = true;
        } else {
            throw new Error(`Unknown arg: ${arg}`);
        }
    }

    return { port, host, reset, persistServerUrl, allowSettingsWrite };
}

export function formatServerUrl(host: string, port: number): string {
    const connectHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const formattedHost = isIP(connectHost) === 6 ? `[${connectHost}]` : connectHost;
    return `http://${formattedHost}:${port}`;
}

function showHelp() {
    console.log(`
${chalk.bold('idle server')} - Run the Idle sync server + web app locally (self-host)

${chalk.bold('Usage:')}
  idle server [--port 3005] [--host 127.0.0.1] [--reset] [--no-persist]

${chalk.bold('Options:')}
  --port, -p <n>        Port to listen on (default: 3005)
  --host <ip>           Host to bind (default: 127.0.0.1)
  --reset               Wipe local server data before starting
  --no-persist          Don't write serverUrl into settings.json
  ${SETTINGS_WRITE_CONFIRM_FLAG}
                        Write settings.serverUrl/settings.webappUrl without prompting
${chalk.bold('Notes:')}
  - Stores data in ${chalk.cyan('$IDLE_HOME_DIR/server-data/')}
  - Creates a private 32-byte server-secret file on first run; only its path reaches child processes
  - Packaged installs include ${chalk.cyan(SERVER_PACKAGE_NAME)} as an exact dependency
  - By default, asks before writing ${chalk.cyan('settings.serverUrl')} and ${chalk.cyan('settings.webappUrl')}
  - Use ${chalk.cyan('--no-persist')} to run without modifying default Idle settings
  - Open ${chalk.cyan('http://127.0.0.1:<port>')} for the web app (if built)
`);
}

async function ensureSettingsWriteAllowed(opts: ServerOptions, serverUrl: string): Promise<void> {
    if (!opts.persistServerUrl || opts.allowSettingsWrite) {
        return;
    }

    const message =
        `idle server will write settings.serverUrl and settings.webappUrl to ${serverUrl} ` +
        `in ${configuration.settingsFile}.`;

    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        console.error(chalk.red('Refusing to modify default Idle settings from a non-interactive run.'));
        console.error(chalk.gray(message));
        console.error(chalk.gray(`Re-run with --no-persist, or pass ${SETTINGS_WRITE_CONFIRM_FLAG}.`));
        process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(`${chalk.yellow(message)} Continue? ${chalk.gray('[y/N]')} `);
        const normalized = answer.trim().toLowerCase();
        if (normalized !== 'y' && normalized !== 'yes') {
            console.error(chalk.gray('Cancelled. Re-run with --no-persist to start without changing settings.'));
            process.exit(1);
        }
    } finally {
        rl.close();
    }
}

function assertOwnedByCurrentUser(uid: number, label: string): void {
    if (typeof process.getuid === 'function' && uid !== process.getuid()) {
        throw new Error(`${label} is not owned by the current user`);
    }
}

export function ensurePrivateServerDataDirectory(dataDir: string): void {
    assertNoSymbolicLinkComponents(dataDir);
    if (existsSync(dataDir)) {
        const existing = lstatSync(dataDir);
        if (existing.isSymbolicLink()) {
            throw new Error('Idle server data directory must not be a symbolic link');
        }
        if (!existing.isDirectory()) {
            throw new Error('Idle server data path must be a directory');
        }
        assertOwnedByCurrentUser(existing.uid, 'Idle server data directory');
    } else {
        mkdirSync(dataDir, { mode: 0o700 });
    }

    assertNoSymbolicLinkComponents(dataDir);
    const verified = lstatSync(dataDir);
    if (verified.isSymbolicLink() || !verified.isDirectory()) {
        throw new Error('Idle server data directory must be a real directory, not a symbolic link');
    }
    assertOwnedByCurrentUser(verified.uid, 'Idle server data directory');
    chmodSync(dataDir, 0o700);
}

function assertNoSymbolicLinkComponents(targetPath: string): void {
    const absolute = path.resolve(targetPath);
    const root = path.parse(absolute).root;
    const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    for (const component of components) {
        current = path.join(current, component);
        if (!existsSync(current)) break;
        if (lstatSync(current).isSymbolicLink()) {
            throw new Error('Idle server data path must not contain a symbolic link');
        }
    }
}

interface FileIdentity {
    dev: number;
    ino: number;
}

export function openedMasterSecretMatchesPath(initial: FileIdentity, opened: FileIdentity): boolean {
    return initial.dev === opened.dev && initial.ino === opened.ino;
}

function readExistingMasterSecret(file: string, exposeValue: true): string;
function readExistingMasterSecret(file: string, exposeValue: false): void;
function readExistingMasterSecret(file: string, exposeValue: boolean): string | void {
    const pathInfo = lstatSync(file);
    if (pathInfo.isSymbolicLink()) {
        throw new Error('Idle server master secret must not be a symbolic link');
    }
    if (!pathInfo.isFile() || pathInfo.nlink !== 1) {
        throw new Error('Idle server master secret must be a single-link regular file');
    }

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const fd = openSync(file, fsConstants.O_RDONLY | noFollow);
    let secretBytes: Buffer | undefined;
    try {
        const info = fstatSync(fd);
        if (!openedMasterSecretMatchesPath(pathInfo, info)) {
            throw new Error('Idle server master secret changed while it was being opened');
        }
        if (!info.isFile() || info.nlink !== 1) {
            throw new Error('Idle server master secret must be a single-link regular file');
        }
        assertOwnedByCurrentUser(info.uid, 'Idle server master secret');
        if (info.size !== 64) {
            throw new Error('Idle server master secret must contain exactly 64 hexadecimal characters');
        }
        fchmodSync(fd, 0o600);
        secretBytes = Buffer.alloc(65);
        let offset = 0;
        while (offset < secretBytes.length) {
            const bytesRead = readSync(fd, secretBytes, offset, secretBytes.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset !== 64) {
            throw new Error('Idle server master secret must contain exactly 64 hexadecimal characters');
        }
        for (let index = 0; index < 64; index++) {
            const byte = secretBytes[index];
            const isDecimal = byte >= 0x30 && byte <= 0x39;
            const isLowercaseHex = byte >= 0x61 && byte <= 0x66;
            const isUppercaseHex = byte >= 0x41 && byte <= 0x46;
            if (!isDecimal && !isLowercaseHex && !isUppercaseHex) {
                throw new Error('Idle server master secret must contain exactly 64 hexadecimal characters');
            }
        }
        if (exposeValue) {
            return secretBytes.subarray(0, 64).toString('utf8');
        }
    } finally {
        secretBytes?.fill(0);
        closeSync(fd);
    }
}

function validateExistingMasterSecretFile(file: string): void {
    readExistingMasterSecret(file, false);
}

function createMasterSecretFile(dataDir: string, file: string): void {
    const randomSecret = randomBytes(32);
    const encodedSecret = Buffer.alloc(64);
    const hexadecimalAlphabet = Buffer.from('0123456789abcdef', 'ascii');
    for (let index = 0; index < randomSecret.length; index++) {
        encodedSecret[index * 2] = hexadecimalAlphabet[randomSecret[index] >>> 4];
        encodedSecret[(index * 2) + 1] = hexadecimalAlphabet[randomSecret[index] & 0x0f];
    }
    const temporary = path.join(dataDir, `.master-secret.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let fd: number | undefined;
    try {
        fd = openSync(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
            0o600,
        );
        fchmodSync(fd, 0o600);
        writeFileSync(fd, encodedSecret);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;

        try {
            linkSync(temporary, file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                return;
            }
            throw error;
        }
    } finally {
        randomSecret.fill(0);
        encodedSecret.fill(0);
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

export function ensureMasterSecretFile(dataDir: string): string {
    ensurePrivateServerDataDirectory(dataDir);
    const file = path.join(dataDir, 'master-secret');
    if (!existsSync(file)) {
        createMasterSecretFile(dataDir, file);
    }
    validateExistingMasterSecretFile(file);
    return file;
}

export function loadOrCreateMasterSecret(dataDir: string): string {
    return readExistingMasterSecret(ensureMasterSecretFile(dataDir), true);
}

export function clearInheritedServerSecretEnvironment(
    environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
    delete environment.IDLE_MASTER_SECRET;
    delete environment.IDLE_MASTER_SECRET_FILE;
}

export function createServerChildEnvironment(
    baseEnvironment: NodeJS.ProcessEnv | Record<string, string | undefined>,
    options: ServerChildEnvironmentOptions,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
    clearInheritedServerSecretEnvironment(environment);
    environment.DB_PROVIDER = 'pglite';
    environment.DATA_DIR = options.dataDir;
    environment.PGLITE_DIR = options.pgliteDir;
    environment.IDLE_MASTER_SECRET_FILE = options.secretFile;
    environment.PORT = String(options.port);
    environment.HOST = options.host;
    if (options.staticDir) environment.IDLE_STATIC_DIR = options.staticDir;
    environment.IDLE_INJECT_HTML_CONFIG = JSON.stringify({
        serverUrl: options.serverUrl,
        disableAnalytics: true,
    });
    return environment;
}

/**
 * Path to tools/<name>/ shipped alongside the CLI.
 *
 * pkgroll bundles into dist/, so __dirname at runtime is .../idle-cli/dist; tools/ lives
 * at .../idle-cli/tools. In rare layouts (e.g. running un-built source via tsx from src/
 * commands/), tools/ sits at .../idle-cli/tools and __dirname is .../idle-cli/src/commands,
 * so we walk up until we find a directory that contains tools/.
 */
function resolveToolsPath(name: string): string {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'tools', name);
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(__dirname, '..', 'tools', name);
}

function serverArtifactMode(artifacts: ServerArtifacts): string {
    if (artifacts.source === 'package') return SERVER_PACKAGE_NAME;
    return 'source (dev)';
}

/**
 * Resolves the artifacts needed to spawn the Idle server.
 *
 * Order:
 *   1. @northglass/idle-server package (npm-installed local server artifact)
 *   2. Source-mode fallback for monorepo dev: ../idle-server/sources/standalone.ts via tsx
 */
function resolveServerArtifacts(): ServerArtifacts | undefined {
    const packageArtifact = resolveInstalledServerPackage();
    if (packageArtifact) return packageArtifact;

    const sourceEntry = findSourceStandalone();
    if (sourceEntry) {
        const tsx = findTsxBinary(path.dirname(path.dirname(sourceEntry)));
        const useNode = tsx !== 'tsx';
        return {
            command: useNode ? process.execPath : 'tsx',
            prefixArgs: useNode ? [tsx, sourceEntry] : [sourceEntry],
            cwd: path.dirname(path.dirname(sourceEntry)),
            source: 'source',
        };
    }

    return undefined;
}

function resolveInstalledServerPackage(): ServerArtifacts | undefined {
    try {
        const serverPackage = require_(SERVER_PACKAGE_NAME) as {
            resolveServerArtifact?: () => IdleServerPackageArtifact | undefined;
        };
        const artifact = serverPackage.resolveServerArtifact?.();
        if (!artifact || !artifact.command || !existsSync(artifact.command)) {
            return undefined;
        }
        return {
            command: artifact.command,
            prefixArgs: artifact.prefixArgs ?? [],
            cwd: artifact.cwd,
            source: 'package',
            webappDir: artifact.webappDir,
        };
    } catch {
        return undefined;
    }
}

function findSourceStandalone(): string | undefined {
    const candidates = [
        path.resolve(__dirname, '../../../idle-server/sources/standalone.ts'),
        path.resolve(__dirname, '../../idle-server/sources/standalone.ts'),
        path.resolve(process.cwd(), 'packages/idle-server/sources/standalone.ts'),
        path.resolve(process.cwd(), '../idle-server/sources/standalone.ts'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return undefined;
}

function findWebappDir(): string | undefined {
    const bundled = resolveToolsPath('webapp');
    if (existsSync(path.join(bundled, 'index.html'))) return bundled;

    const candidates = [
        path.resolve(__dirname, '../../../idle-app/dist'),
        path.resolve(__dirname, '../../idle-app/dist'),
        path.resolve(process.cwd(), 'packages/idle-app/dist'),
    ];
    for (const c of candidates) {
        if (existsSync(path.join(c, 'index.html'))) return c;
    }
    return undefined;
}

function findTsxBinary(cwd: string): string {
    try {
        return require_.resolve('tsx/cli', { paths: [cwd] });
    } catch {
        return 'tsx';
    }
}

interface ChildExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function waitForChild(child: ChildProcess): Promise<ChildExitResult> {
    return new Promise<ChildExitResult>((resolve, reject) => {
        const onError = () => {
            child.removeListener('exit', onExit);
            reject(new Error('Unable to start the Idle server runtime'));
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            child.removeListener('error', onError);
            resolve({ code, signal });
        };
        child.once('error', onError);
        child.once('exit', onExit);
    });
}

async function spawnAndWait(
    art: ServerArtifacts,
    env: NodeJS.ProcessEnv,
    args: string[],
    trackChild: (child: ChildProcess | undefined) => void,
): Promise<void> {
    const cmdArgs = [...art.prefixArgs, ...args];
    const child = spawn(art.command, cmdArgs, { cwd: art.cwd, env, stdio: 'inherit' });
    trackChild(child);
    try {
        const result = await waitForChild(child);
        if (result.code !== 0) {
            throw new Error(`idle-server ${args[0]} did not complete successfully`);
        }
    } finally {
        trackChild(undefined);
    }
}

function spawnBackground(art: ServerArtifacts, env: NodeJS.ProcessEnv, args: string[]): ChildProcess {
    const cmdArgs = [...art.prefixArgs, ...args];
    return spawn(art.command, cmdArgs, { cwd: art.cwd, env, stdio: 'inherit' });
}
