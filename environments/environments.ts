import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import * as crypto from "crypto";
import { execFileSync, spawn, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import tweetnacl from "tweetnacl";
import {
    getAuthPublicKey,
    libsodiumEncryptForPublicKey,
    signAuthChallenge,
} from "../packages/idle-cli/src/api/encryption";
import { decryptPairingCredentials } from "../packages/idle-cli/src/api/pairing";

// ============================================================================
// Configuration
// ============================================================================

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENVIRONMENTS_ROOT = path.join(REPO_ROOT, "environments");
const ENVIRONMENTS_DATA_DIR = path.join(ENVIRONMENTS_ROOT, "data");
const ENVIRONMENTS_DIR = path.join(ENVIRONMENTS_DATA_DIR, "envs");
const CURRENT_ENV_PATH = path.join(ENVIRONMENTS_DATA_DIR, "current.json");
const LAB_RAT_PROJECT_TEMPLATE_DIR = path.join(ENVIRONMENTS_ROOT, "lab-rat-todo-project");
const MASTER_SECRET_FILE = "master-secret";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_CURRENT_CONFIG_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_CONFIG_BYTES = 64 * 1024;
const MAX_MASTER_SECRET_BYTES = 1024;
const MAX_PROCESS_STATE_BYTES = 32 * 1024;
const MAX_SEED_AUTH_RESPONSE_BYTES = 128 * 1024;
const WEB_START_TIMEOUT_MS = 60_000;
const PROCESS_NONCE_ENV = "IDLE_ENV_LAUNCH_NONCE";
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

// ============================================================================
// Name generation (expanded from packages/idle-app/sources/utils/generateWorktreeName.ts)
// ============================================================================

const adjectives = [
    "clever", "idle", "swift", "bright", "calm",
    "bold", "quiet", "brave", "wise", "eager",
    "gentle", "quick", "sharp", "smooth", "fresh",
    "warm", "cool", "vivid", "lucid", "nimble",
    "keen", "fair", "grand", "sleek", "merry",
    "noble", "agile", "witty", "crisp", "snug",
    "jolly", "lush", "deft", "tidy", "stout",
    "plush", "brisk", "prime", "true", "zesty",
];

const nouns = [
    "ocean", "forest", "cloud", "star", "river",
    "mountain", "valley", "bridge", "beacon", "harbor",
    "garden", "meadow", "canyon", "island", "desert",
    "glacier", "aurora", "lagoon", "summit", "prairie",
    "reef", "grove", "delta", "ridge", "oasis",
    "crater", "fjord", "marsh", "bluff", "dune",
    "spring", "atlas", "comet", "ember", "frost",
    "pearl", "cedar", "maple", "birch", "coral",
];

function randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

function generateName(): string {
    return `${randomChoice(adjectives)}-${randomChoice(nouns)}`;
}

// ============================================================================
// Port allocation
// ============================================================================

function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
                server.close();
                reject(new Error("Failed to allocate port"));
                return;
            }
            const port = addr.port;
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

// ============================================================================
// Types
// ============================================================================

export interface EnvironmentConfig {
    name: string;
    serverPort: number;
    expoPort: number;
    createdAt: string;
    template: Template;
    projectTemplate: "lab-rat-todo-project";
    projectPath: string;
    cliCommand?: string;
}

interface CurrentConfig {
    current: string;
}

export interface ProcessIdentity {
    pid: number;
    uid: number;
    processGroupId: number;
    cwd: string;
    executable: string;
    commandFingerprint: string;
    startMarker: string;
    launchNonce: string;
}

export interface ManagedProcessState extends ProcessIdentity {
    schemaVersion: 1;
    service: "server" | "web";
}

// ============================================================================
// Helpers
// ============================================================================

function currentUid(): number | null {
    return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertPathInside(managedRoot: string, targetPath: string): { root: string; target: string } {
    const root = path.resolve(managedRoot);
    const target = path.resolve(targetPath);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Managed path escapes its root: ${target}`);
    }
    return { root, target };
}

function lstatIfPresent(targetPath: string): fs.Stats | null {
    try {
        return fs.lstatSync(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

function assertDirectoryNoSymlink(directoryPath: string): void {
    const stat = fs.lstatSync(directoryPath);
    if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in managed path: ${directoryPath}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`Managed path component is not a directory: ${directoryPath}`);
    }
}

function assertSafeManagedPath(managedRoot: string, targetPath: string, allowMissingLeaf = false): void {
    const { root, target } = assertPathInside(managedRoot, targetPath);
    assertDirectoryNoSymlink(root);
    const relative = path.relative(root, target);
    if (!relative) return;

    const components = relative.split(path.sep);
    let current = root;
    for (let index = 0; index < components.length; index++) {
        current = path.join(current, components[index]);
        const stat = lstatIfPresent(current);
        const isLeaf = index === components.length - 1;
        if (!stat) {
            if (allowMissingLeaf && isLeaf) return;
            throw new Error(`Missing managed path component: ${current}`);
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing symbolic link in managed path: ${current}`);
        }
        if (!isLeaf && !stat.isDirectory()) {
            throw new Error(`Managed path component is not a directory: ${current}`);
        }
    }
}

function assertOwnedByCurrentUser(stat: fs.Stats, targetPath: string): void {
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
        throw new Error(`Managed path is not owned by the current user: ${targetPath}`);
    }
}

export function ensurePrivateDirectory(managedRoot: string, targetDirectory: string): void {
    const { root, target } = assertPathInside(managedRoot, targetDirectory);
    assertDirectoryNoSymlink(root);
    const relative = path.relative(root, target);
    if (!relative) return;

    let current = root;
    for (const component of relative.split(path.sep)) {
        current = path.join(current, component);
        let stat = lstatIfPresent(current);
        if (!stat) {
            fs.mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing symbolic link in managed path: ${current}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Managed path component is not a directory: ${current}`);
        }
        assertOwnedByCurrentUser(stat, current);
        fs.chmodSync(current, PRIVATE_DIRECTORY_MODE);
    }
}

function assertSafeFileLeaf(managedRoot: string, filePath: string, allowMissing: boolean): fs.Stats | null {
    const parent = path.dirname(path.resolve(filePath));
    assertSafeManagedPath(managedRoot, parent);
    const stat = lstatIfPresent(filePath);
    if (!stat) {
        if (allowMissing) return null;
        throw new Error(`Missing managed file: ${filePath}`);
    }
    if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link managed file: ${filePath}`);
    }
    if (!stat.isFile()) {
        throw new Error(`Managed path is not a regular file: ${filePath}`);
    }
    assertOwnedByCurrentUser(stat, filePath);
    return stat;
}

function noFollowError(error: unknown, filePath: string): Error {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
        return new Error(`Refusing symbolic link/no-follow file: ${filePath}`);
    }
    return error instanceof Error ? error : new Error(String(error));
}

export function atomicWritePrivateFile(
    managedRoot: string,
    filePath: string,
    contents: string | Uint8Array,
    mode = PRIVATE_FILE_MODE,
): void {
    assertSafeFileLeaf(managedRoot, filePath, true);
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
            mode,
        );
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) throw new Error(`Temporary managed path is not a regular file: ${temporaryPath}`);
        assertOwnedByCurrentUser(stat, temporaryPath);
        fs.fchmodSync(descriptor, mode);
        fs.writeFileSync(descriptor, contents);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;

        // A rename replaces an existing leaf rather than following it. Recheck the
        // private parent immediately before the atomic replacement.
        assertSafeManagedPath(managedRoot, directory);
        const destination = lstatIfPresent(filePath);
        if (destination?.isSymbolicLink()) {
            throw new Error(`Refusing symbolic link managed file: ${filePath}`);
        }
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        throw noFollowError(error, filePath);
    } finally {
        if (descriptor !== null) {
            try { fs.closeSync(descriptor); } catch {}
        }
        try { fs.unlinkSync(temporaryPath); } catch {}
    }
}

export function readBoundedFileNoFollow(managedRoot: string, filePath: string, maxBytes: number): string {
    const before = assertSafeFileLeaf(managedRoot, filePath, false)!;
    let descriptor: number;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
        throw noFollowError(error, filePath);
    }

    try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error(`Managed file changed during no-follow open: ${filePath}`);
        }
        assertOwnedByCurrentUser(opened, filePath);
        if (opened.size > maxBytes) {
            throw new Error(`Managed file is too large: ${filePath}`);
        }
        if (process.platform !== "win32") fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);

        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
            const chunk = Buffer.alloc(Math.min(8192, maxBytes + 1 - total));
            if (chunk.length === 0) throw new Error(`Managed file is too large: ${filePath}`);
            const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > maxBytes) throw new Error(`Managed file is too large: ${filePath}`);
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks).toString("utf8");
    } finally {
        fs.closeSync(descriptor);
    }
}

export function openPrivateAppendFile(managedRoot: string, filePath: string): number {
    assertSafeFileLeaf(managedRoot, filePath, true);
    let descriptor: number;
    try {
        descriptor = fs.openSync(
            filePath,
            fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW,
            PRIVATE_FILE_MODE,
        );
    } catch (error) {
        throw noFollowError(error, filePath);
    }
    try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile()) throw new Error(`Log path is not a regular file: ${filePath}`);
        assertOwnedByCurrentUser(stat, filePath);
        if (process.platform !== "win32") fs.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        return descriptor;
    } catch (error) {
        fs.closeSync(descriptor);
        throw error;
    }
}

function ensureEnvironmentsDir(): void {
    assertDirectoryNoSymlink(ENVIRONMENTS_ROOT);
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, ENVIRONMENTS_DATA_DIR);
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, ENVIRONMENTS_DIR);
}

function readCurrentConfig(): CurrentConfig | null {
    ensureEnvironmentsDir();
    if (!lstatIfPresent(CURRENT_ENV_PATH)) return null;
    let value: unknown;
    try {
        value = JSON.parse(readBoundedFileNoFollow(ENVIRONMENTS_ROOT, CURRENT_ENV_PATH, MAX_CURRENT_CONFIG_BYTES));
    } catch (error) {
        throw new Error(`Invalid current environment configuration: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { current?: unknown }).current !== "string") {
        throw new Error("Invalid current environment configuration.");
    }
    const current = (value as { current: string }).current;
    getEnvironmentDir(current);
    return { current };
}

function writeCurrentConfig(current: string): void {
    getEnvironmentDir(current);
    ensureEnvironmentsDir();
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        CURRENT_ENV_PATH,
        JSON.stringify({ current }, null, 4) + "\n",
    );
}

export function parseEnvironmentConfigValue(name: string, envDir: string, value: unknown): EnvironmentConfig {
    const invalid = () => new Error(`Invalid environment configuration for "${name}".`);
    if (!isValidEnvironmentName(name) || !value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const raw = value as Record<string, unknown>;
    const expectedProjectPath = path.join(path.resolve(envDir), "project");
    const createdAt = typeof raw.createdAt === "string" ? new Date(raw.createdAt) : null;
    if (
        raw.name !== name ||
        typeof raw.serverPort !== "number" || !Number.isInteger(raw.serverPort) || raw.serverPort < 1 || raw.serverPort > 65535 ||
        typeof raw.expoPort !== "number" || !Number.isInteger(raw.expoPort) || raw.expoPort < 1 || raw.expoPort > 65535 ||
        raw.serverPort === raw.expoPort ||
        !createdAt || !Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== raw.createdAt ||
        typeof raw.template !== "string" || !VALID_TEMPLATES.includes(raw.template as Template) ||
        raw.projectTemplate !== "lab-rat-todo-project" ||
        typeof raw.projectPath !== "string" || path.resolve(raw.projectPath) !== expectedProjectPath
    ) throw invalid();

    return {
        name,
        serverPort: raw.serverPort,
        expoPort: raw.expoPort,
        createdAt: raw.createdAt,
        template: raw.template as Template,
        projectTemplate: "lab-rat-todo-project",
        projectPath: expectedProjectPath,
        cliCommand: buildCliCommand(),
    };
}

function readEnvironmentConfig(name: string): EnvironmentConfig {
    const envDir = getEnvironmentDir(name);
    assertSafeManagedPath(ENVIRONMENTS_ROOT, envDir);
    const configPath = path.join(envDir, "environment.json");
    let value: unknown;
    try {
        value = JSON.parse(readBoundedFileNoFollow(ENVIRONMENTS_ROOT, configPath, MAX_ENVIRONMENT_CONFIG_BYTES));
    } catch (error) {
        throw new Error(`Invalid environment configuration for "${name}": ${(error as Error).message}`);
    }
    return parseEnvironmentConfigValue(name, envDir, value);
}

function writeEnvironmentConfig(config: EnvironmentConfig): void {
    const envDir = getEnvironmentDir(config.name);
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, envDir);
    const normalized = parseEnvironmentConfigValue(config.name, envDir, config);
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        path.join(envDir, "environment.json"),
        JSON.stringify(normalized, null, 4) + "\n",
    );
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        path.join(envDir, "env.sh"),
        buildEnvSh(normalized.name, envDir, normalized.serverPort, normalized.expoPort),
    );
}

function listEnvironments(): string[] {
    ensureEnvironmentsDir();
    const entries = fs.readdirSync(ENVIRONMENTS_DIR, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
        if (!isValidEnvironmentName(entry.name)) continue;
        const envDir = path.join(ENVIRONMENTS_DIR, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link environment: ${envDir}`);
        if (!entry.isDirectory()) continue;
        assertSafeManagedPath(ENVIRONMENTS_ROOT, envDir);
        const configStat = lstatIfPresent(path.join(envDir, "environment.json"));
        if (!configStat) continue;
        if (configStat.isSymbolicLink()) throw new Error(`Refusing symbolic link environment config: ${entry.name}`);
        if (configStat.isFile()) names.push(entry.name);
    }
    return names.sort();
}

function ensureLabRatProjectTemplate(): void {
    const stat = lstatIfPresent(LAB_RAT_PROJECT_TEMPLATE_DIR);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Missing or unsafe lab-rat project template at ${LAB_RAT_PROJECT_TEMPLATE_DIR}`);
    }
}

function copyLabRatProject(envDir: string): string {
    ensureLabRatProjectTemplate();
    const targetDir = path.join(envDir, "project");
    if (lstatIfPresent(targetDir)) throw new Error(`Project target already exists: ${targetDir}`);
    assertSafeManagedPath(ENVIRONMENTS_ROOT, envDir);
    fs.cpSync(LAB_RAT_PROJECT_TEMPLATE_DIR, targetDir, { recursive: true, dereference: false, errorOnExist: true });
    return targetDir;
}

function isPortInUse(port: number): boolean {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    try {
        const result = execFileSync("lsof", ["-i", `tcp:${port}`, "-sTCP:LISTEN", "-t"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return result.trim().length > 0;
    } catch {
        return false;
    }
}

// ============================================================================
// Managed process state
// ============================================================================

function processStatePath(envDir: string, service: "server" | "web"): string {
    return path.join(envDir, "pids", `${service}.process.json`);
}

function legacyPidPath(envDir: string, service: "server" | "web"): string {
    return path.join(envDir, "pids", `${service}.pid`);
}

function readSystemFileBounded(filePath: string, maxBytes: number): Buffer {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
            const chunk = Buffer.alloc(Math.min(8192, maxBytes + 1 - total));
            if (chunk.length === 0) throw new Error(`System process file exceeded ${maxBytes} bytes`);
            const count = fs.readSync(descriptor, chunk, 0, chunk.length, null);
            if (count === 0) break;
            total += count;
            if (total > maxBytes) throw new Error(`System process file exceeded ${maxBytes} bytes`);
            chunks.push(chunk.subarray(0, count));
        }
        return Buffer.concat(chunks);
    } finally {
        fs.closeSync(descriptor);
    }
}

function execText(command: string, args: string[]): string {
    return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024 * 1024,
    }).trim();
}

function fingerprintCommand(command: string): string {
    return crypto.createHash("sha256").update(command).digest("hex");
}

function captureLinuxProcessIdentity(pid: number, expectedNonce: string): ProcessIdentity | null {
    const procRoot = `/proc/${pid}`;
    const statText = readSystemFileBounded(path.join(procRoot, "stat"), 64 * 1024).toString("utf8").trim();
    const closeParen = statText.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = statText.slice(closeParen + 2).split(/\s+/);
    const processGroupId = Number(fields[2]); // proc stat field 5
    const startMarker = fields[19]; // proc stat field 22
    const status = readSystemFileBounded(path.join(procRoot, "status"), 256 * 1024).toString("utf8");
    const uidMatch = status.match(/^Uid:\s+(\d+)/m);
    if (!uidMatch || !startMarker) return null;

    const environment = readSystemFileBounded(path.join(procRoot, "environ"), 1024 * 1024).toString("utf8");
    const nonceEntry = environment.split("\0").find(entry => entry.startsWith(`${PROCESS_NONCE_ENV}=`));
    if (nonceEntry !== `${PROCESS_NONCE_ENV}=${expectedNonce}`) return null;

    const command = readSystemFileBounded(path.join(procRoot, "cmdline"), 1024 * 1024)
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
    return {
        pid,
        uid: Number(uidMatch[1]),
        processGroupId,
        cwd: fs.realpathSync(path.join(procRoot, "cwd")),
        executable: fs.realpathSync(path.join(procRoot, "exe")),
        commandFingerprint: fingerprintCommand(command),
        startMarker,
        launchNonce: expectedNonce,
    };
}

function captureDarwinProcessIdentity(pid: number, expectedNonce: string): ProcessIdentity | null {
    const pidArg = String(pid);
    const uid = Number(execText("ps", ["-p", pidArg, "-o", "uid="]));
    const processGroupId = Number(execText("ps", ["-p", pidArg, "-o", "pgid="]));
    const startMarker = execText("ps", ["-p", pidArg, "-o", "lstart="]);
    const executable = execText("ps", ["-p", pidArg, "-o", "comm="]);
    const command = execText("ps", ["-ww", "-p", pidArg, "-o", "command="]);
    const commandAndEnvironment = execText("ps", ["eww", "-p", pidArg, "-o", "command="]);
    const noncePattern = new RegExp(`(?:^|\\s)${PROCESS_NONCE_ENV}=([a-f0-9]{64})(?:\\s|$)`);
    if (commandAndEnvironment.match(noncePattern)?.[1] !== expectedNonce) return null;

    const lsof = execText("lsof", ["-a", "-p", pidArg, "-d", "cwd", "-Fn"]);
    const cwdLine = lsof.split("\n").find(line => line.startsWith("n"));
    if (!cwdLine) return null;
    return {
        pid,
        uid,
        processGroupId,
        cwd: fs.realpathSync(cwdLine.slice(1)),
        executable,
        commandFingerprint: fingerprintCommand(command),
        startMarker,
        launchNonce: expectedNonce,
    };
}

export function captureProcessIdentity(pid: number, expectedNonce: string): ProcessIdentity | null {
    if (!Number.isSafeInteger(pid) || pid <= 1 || !/^[a-f0-9]{64}$/.test(expectedNonce)) return null;
    try {
        if (process.platform === "linux") return captureLinuxProcessIdentity(pid, expectedNonce);
        if (process.platform === "darwin") return captureDarwinProcessIdentity(pid, expectedNonce);
        return null;
    } catch {
        return null;
    }
}

export function parseManagedProcessState(value: unknown, expectedService: "server" | "web"): ManagedProcessState {
    const invalid = () => new Error(`Invalid managed process state for ${expectedService}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const raw = value as Record<string, unknown>;
    if (
        raw.schemaVersion !== 1 || raw.service !== expectedService ||
        typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 1 ||
        typeof raw.uid !== "number" || !Number.isSafeInteger(raw.uid) || raw.uid < 0 ||
        typeof raw.processGroupId !== "number" || !Number.isSafeInteger(raw.processGroupId) || raw.processGroupId !== raw.pid ||
        typeof raw.cwd !== "string" || raw.cwd.length === 0 || raw.cwd.includes("\0") ||
        typeof raw.executable !== "string" || raw.executable.length === 0 || raw.executable.includes("\0") ||
        typeof raw.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.commandFingerprint) ||
        typeof raw.startMarker !== "string" || raw.startMarker.length === 0 || raw.startMarker.length > 256 || /[\r\n]/.test(raw.startMarker) ||
        typeof raw.launchNonce !== "string" || !/^[a-f0-9]{64}$/.test(raw.launchNonce)
    ) throw invalid();

    return {
        schemaVersion: 1,
        service: expectedService,
        pid: raw.pid,
        uid: raw.uid,
        processGroupId: raw.processGroupId,
        cwd: raw.cwd,
        executable: raw.executable,
        commandFingerprint: raw.commandFingerprint,
        startMarker: raw.startMarker,
        launchNonce: raw.launchNonce,
    };
}

export function verifyManagedProcessIdentity(state: ManagedProcessState, identity: ProcessIdentity): boolean {
    return state.pid === identity.pid
        && state.uid === identity.uid
        && state.processGroupId === identity.processGroupId
        && state.cwd === identity.cwd
        && state.executable === identity.executable
        && state.commandFingerprint === identity.commandFingerprint
        && state.startMarker === identity.startMarker
        && state.launchNonce === identity.launchNonce;
}

export function promoteManagedProcessIdentityAfterReadiness(
    launchState: ManagedProcessState,
    runtimeIdentity: ProcessIdentity,
): ManagedProcessState {
    const stableIdentityMatches = launchState.pid === runtimeIdentity.pid
        && launchState.uid === runtimeIdentity.uid
        && launchState.processGroupId === runtimeIdentity.processGroupId
        && launchState.cwd === runtimeIdentity.cwd
        && launchState.startMarker === runtimeIdentity.startMarker
        && launchState.launchNonce === runtimeIdentity.launchNonce;
    if (!stableIdentityMatches) {
        throw new Error(`Refusing ready ${launchState.service} process with changed stable process identity`);
    }

    return parseManagedProcessState({
        schemaVersion: 1,
        service: launchState.service,
        ...runtimeIdentity,
    }, launchState.service);
}

function writeManagedProcessState(envDir: string, state: ManagedProcessState): void {
    const stateDirectory = path.join(envDir, "pids");
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, stateDirectory);
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        processStatePath(envDir, state.service),
        JSON.stringify(state, null, 2) + "\n",
    );
}

function readManagedProcessState(envDir: string, service: "server" | "web"): ManagedProcessState | null {
    const statePath = processStatePath(envDir, service);
    if (!lstatIfPresent(statePath)) return null;
    let value: unknown;
    try {
        value = JSON.parse(readBoundedFileNoFollow(ENVIRONMENTS_ROOT, statePath, MAX_PROCESS_STATE_BYTES));
    } catch (error) {
        throw new Error(`Invalid managed process state for ${service}: ${(error as Error).message}`);
    }
    return parseManagedProcessState(value, service);
}

function removeManagedFile(filePath: string): void {
    const stat = assertSafeFileLeaf(ENVIRONMENTS_ROOT, filePath, true);
    if (!stat) return;
    fs.unlinkSync(filePath);
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function stopManagedService(envDir: string, service: "server" | "web"): boolean {
    const legacyPath = legacyPidPath(envDir, service);
    if (lstatIfPresent(legacyPath)) {
        throw new Error(
            `Refusing unverified legacy PID state for ${service}: ${legacyPath}. ` +
            `Remove it only after confirming the old process is stopped.`,
        );
    }

    const state = readManagedProcessState(envDir, service);
    if (!state) return false;
    if (!isProcessAlive(state.pid)) {
        removeManagedFile(processStatePath(envDir, service));
        return false;
    }
    const identity = captureProcessIdentity(state.pid, state.launchNonce);
    if (!identity || !verifyManagedProcessIdentity(state, identity)) {
        throw new Error(`Refusing to signal ${service}: PID ${state.pid} no longer matches its recorded identity.`);
    }
    const uid = currentUid();
    if (uid !== null && identity.uid !== uid) {
        throw new Error(`Refusing to signal ${service}: PID ${state.pid} is owned by another user.`);
    }
    if (identity.processGroupId !== identity.pid) {
        throw new Error(`Refusing to signal ${service}: PID ${state.pid} is not its process-group leader.`);
    }

    process.kill(-identity.processGroupId, "SIGTERM");
    removeManagedFile(processStatePath(envDir, service));
    return true;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { if (await check()) return; } catch {}
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function spawnService(
    service: "server" | "web",
    command: string,
    args: string[],
    opts: { envDir: string; cwd: string; env: Record<string, string | undefined>; logFile: string },
): ManagedProcessState {
    const logDir = path.dirname(opts.logFile);
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, logDir);
    const logFd = openPrivateAppendFile(ENVIRONMENTS_ROOT, opts.logFile);
    const launchNonce = crypto.randomBytes(32).toString("hex");
    const child = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...opts.env, [PROCESS_NONCE_ENV]: launchNonce },
        stdio: ["ignore", logFd, logFd],
        detached: true,
    });
    fs.closeSync(logFd);
    const pid = child.pid;
    if (!pid || pid <= 1) {
        try { child.kill("SIGKILL"); } catch {}
        throw new Error(`Failed to start managed ${service} process`);
    }
    child.unref();

    let identity: ProcessIdentity | null = null;
    for (let attempt = 0; attempt < 20 && !identity; attempt++) {
        identity = captureProcessIdentity(pid, launchNonce);
        if (!identity) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    const expectedCwd = fs.realpathSync(opts.cwd);
    const uid = currentUid();
    if (
        !identity || identity.processGroupId !== pid || identity.cwd !== expectedCwd ||
        (uid !== null && identity.uid !== uid)
    ) {
        try { process.kill(pid, "SIGKILL"); } catch {}
        throw new Error(`Could not verify managed ${service} process identity`);
    }

    const state: ManagedProcessState = { schemaVersion: 1, service, ...identity };
    writeManagedProcessState(opts.envDir, state);
    return state;
}

function recordReadyManagedServiceIdentity(
    envDir: string,
    launchState: ManagedProcessState,
): ManagedProcessState {
    const persistedLaunchState = readManagedProcessState(envDir, launchState.service);
    if (!persistedLaunchState || !verifyManagedProcessIdentity(persistedLaunchState, launchState)) {
        throw new Error(`Managed ${launchState.service} process state changed before readiness`);
    }

    const runtimeIdentity = captureProcessIdentity(launchState.pid, launchState.launchNonce);
    if (!runtimeIdentity) {
        throw new Error(`Could not verify ready ${launchState.service} process identity`);
    }

    const readyState = promoteManagedProcessIdentityAfterReadiness(launchState, runtimeIdentity);
    writeManagedProcessState(envDir, readyState);
    return readyState;
}

export const VALID_TEMPLATES = ["authenticated-empty", "empty"] as const;
export type Template = (typeof VALID_TEMPLATES)[number];

const ENVIRONMENT_NAME_PATTERN = /^[a-z]+-[a-z]+$/;

function isValidEnvironmentName(name: string): boolean {
    return name.length <= 64 && ENVIRONMENT_NAME_PATTERN.test(name);
}

export function getEnvironmentDir(name: string): string {
    if (!isValidEnvironmentName(name)) {
        throw new Error("Invalid environment name. Expected two lowercase words separated by a hyphen.");
    }
    return path.join(ENVIRONMENTS_DIR, name);
}

function masterSecretPath(envDir: string): string {
    return path.join(envDir, "server", MASTER_SECRET_FILE);
}

export function ensureEnvironmentMasterSecret(managedRoot: string, envDir: string): string {
    const serverDirectory = path.join(envDir, "server");
    ensurePrivateDirectory(managedRoot, serverDirectory);
    const secretPath = masterSecretPath(envDir);
    if (!lstatIfPresent(secretPath)) {
        const generated = crypto.randomBytes(32).toString("hex");
        atomicWritePrivateFile(managedRoot, secretPath, `${generated}\n`);
        return generated;
    }

    const secret = readBoundedFileNoFollow(managedRoot, secretPath, MAX_MASTER_SECRET_BYTES).trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) {
        throw new Error(`Invalid environment master secret at ${secretPath}; expected 32 random bytes encoded as hex.`);
    }
    return secret;
}

export function getEnvironmentConfig(name: string): EnvironmentConfig {
    return readEnvironmentConfig(name);
}

export function setEnvironmentTemplate(name: string, template: Template): void {
    const config = readEnvironmentConfig(name);
    writeEnvironmentConfig({ ...config, template });
}

export async function createEnvironment(opts?: { noSwitch?: boolean }): Promise<string> {
    ensureEnvironmentsDir();

    listEnvironments();
    let name = generateName();
    let attempts = 0;
    while (lstatIfPresent(getEnvironmentDir(name)) && attempts < 100) {
        name = generateName();
        attempts++;
    }
    if (lstatIfPresent(getEnvironmentDir(name))) {
        throw new Error("Failed to generate a unique environment name after 100 attempts.");
    }

    const serverPort = await allocatePort();
    const expoPort = await allocatePort();

    const envDir = getEnvironmentDir(name);
    const privateDirs = [
        envDir,
        path.join(envDir, "server"),
        path.join(envDir, "server", "pglite"),
        path.join(envDir, "server", "logs"),
        path.join(envDir, "cli"),
        path.join(envDir, "cli", "home"),
    ];
    for (const privateDir of privateDirs) {
        ensurePrivateDirectory(ENVIRONMENTS_ROOT, privateDir);
    }
    ensureEnvironmentMasterSecret(ENVIRONMENTS_ROOT, envDir);
    const projectPath = copyLabRatProject(envDir);

    const config: EnvironmentConfig = {
        name,
        serverPort,
        expoPort,
        createdAt: new Date().toISOString(),
        template: "empty",
        projectTemplate: "lab-rat-todo-project",
        projectPath,
    };
    writeEnvironmentConfig(config);

    console.log(`Running database migration for ${name}...`);
    const migrationEnv = buildServerEnvVars(envDir, serverPort, expoPort);
    const standaloneTs = path.join(REPO_ROOT, "packages", "idle-server", "sources", "standalone.ts");
    const result = spawnSync(
        "tsx",
        [standaloneTs, "migrate"],
        {
            cwd: path.join(REPO_ROOT, "packages", "idle-server"),
            env: { ...process.env, ...migrationEnv },
            stdio: "inherit",
        }
    );
    if (result.status !== 0) {
        throw new Error(`Migration failed with exit code ${result.status}`);
    }

    if (!opts?.noSwitch) {
        writeCurrentConfig(name);
    }

    console.log("");
    console.log(`Environment created: ${name}`);
    console.log(`  Server: http://localhost:${serverPort}`);
    console.log(`  Webapp: http://localhost:${expoPort}`);
    console.log(`  Project: ${projectPath}`);
    console.log("");
    console.log("Start in separate terminals:");
    console.log("");
    console.log(`  Server:  yarn env:server`);
    console.log(`  Webapp:  yarn env:web`);
    console.log("");
    console.log("CLI (from any terminal, anywhere):");
    console.log("");
    console.log(`  One-liner: ${buildCliCommand()}`);

    return name;
}

export interface TailscaleAccessConfig {
    webOrigin: string;
    serverUrl: string;
    clientEnv: {
        EXPO_PUBLIC_SERVER_URL: string;
        EXPO_PUBLIC_IDLE_SERVER_URL: string;
    };
    serverEnv: {
        IDLE_CORS_ORIGIN: string;
        IDLE_AUTH_AUDIENCE: string;
        PUBLIC_URL: string;
    };
}

export async function startEnvironmentServices(
    name: string,
    access?: TailscaleAccessConfig,
): Promise<void> {
    const envDir = getEnvironmentDir(name);
    const config = readEnvironmentConfig(name);
    const serverEnv: Record<string, string | undefined> = {
        ...process.env,
        ...buildServerEnvVars(envDir, config.serverPort, config.expoPort),
        ...access?.serverEnv,
    };
    const clientEnv = mergeClientEnvironment(
        process.env,
        {
            ...buildClientEnvVars(envDir, config.serverPort, config.expoPort),
            ...access?.clientEnv,
        },
    );

    const serverLogFile = path.join(envDir, "server", "stdout.log");
    console.log(`Starting server on port ${config.serverPort}...`);
    const serverLaunchState = spawnService("server", "yarn", ["standalone", "serve"], {
        envDir,
        cwd: path.join(REPO_ROOT, "packages", "idle-server"),
        env: serverEnv,
        logFile: serverLogFile,
    });

    const serverUrl = `http://localhost:${config.serverPort}`;
    try {
        await waitFor(async () => {
            const res = await fetch(`${serverUrl}/`);
            return res.ok;
        }, 30_000, "server");
        recordReadyManagedServiceIdentity(envDir, serverLaunchState);
    } catch {
        try { stopManagedService(envDir, "server"); } catch {}
        throw new Error(`Server failed to start. Check logs: ${serverLogFile}`);
    }
    console.log(`  Server is healthy.`);

    const webLogFile = path.join(envDir, "web", "stdout.log");
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, path.join(envDir, "web"));
    console.log(`Starting web on port ${config.expoPort}...`);
    const webLaunchState = spawnService("web", "yarn", ["web", "--port", String(config.expoPort)], {
        envDir,
        cwd: path.join(REPO_ROOT, "packages", "idle-app"),
        env: { ...clientEnv, BROWSER: "none" },
        logFile: webLogFile,
    });

    try {
        await waitFor(() => isPortInUse(config.expoPort), WEB_START_TIMEOUT_MS, "web");
        recordReadyManagedServiceIdentity(envDir, webLaunchState);
    } catch {
        try { stopManagedService(envDir, "web"); } catch {}
        try { stopManagedService(envDir, "server"); } catch {}
        throw new Error(`Web failed to start. Check logs: ${webLogFile}`);
    }
    console.log(`  Web is listening.`);
}

function stopEnvironmentDaemon(envDir: string, config: EnvironmentConfig): boolean {
    const idleBin = path.join(REPO_ROOT, "packages", "idle-cli", "bin", "idle.mjs");
    if (!fs.existsSync(idleBin)) return false;
    const daemonEnv = mergeClientEnvironment(
        process.env,
        buildClientEnvVars(envDir, config.serverPort, config.expoPort),
    );
    delete daemonEnv.CLAUDECODE;
    const result = spawnSync(process.execPath, [idleBin, "daemon", "stop"], {
        env: daemonEnv,
        stdio: "ignore",
        timeout: 10_000,
    });
    return result.status === 0;
}

type SeedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readBoundedSeedJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SEED_AUTH_RESPONSE_BYTES) {
        throw new Error("Seed authentication response exceeded the allowed size");
    }
    if (!response.body) throw new Error("Seed authentication returned an empty response");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedBytes += value.byteLength;
            if (receivedBytes > MAX_SEED_AUTH_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error("Seed authentication response exceeded the allowed size");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error("Seed authentication returned invalid JSON");
    }
}

function isValidBase64Field(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 1
        && value.length <= 1024
        && /^[A-Za-z0-9+/=]+$/.test(value);
}

function isUuid(value: unknown): value is string {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCredentialToken(value: unknown): value is string {
    return typeof value === "string" && value.length >= 1 && value.length <= 16 * 1024;
}

function isEncryptedPairingResponse(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 1
        && value.length <= 64 * 1024
        && /^[A-Za-z0-9+/=]+$/.test(value);
}

export interface SeedClientCredentials {
    token: string;
    rpcRegistrationToken: string;
}

export async function authenticateSeedClient(
    serverUrl: string,
    secret: Uint8Array,
    fetchImpl: SeedFetch = fetch,
): Promise<SeedClientCredentials> {
    if (secret.length !== 32) throw new Error("Seed authentication secret must contain exactly 32 bytes");
    const publicKey = getAuthPublicKey(secret);
    const publicKeyBase64 = Buffer.from(publicKey).toString("base64");
    const challengeResponse = await fetchImpl(`${serverUrl}/v1/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 3, publicKey: publicKeyBase64 }),
    });
    if (!challengeResponse.ok) {
        throw new Error(`Auth challenge failed with status ${challengeResponse.status}`);
    }

    const challengeBody = await readBoundedSeedJson(challengeResponse);
    const challengeId = challengeBody && typeof challengeBody === "object"
        ? (challengeBody as { challengeId?: unknown }).challengeId
        : null;
    const challenge = challengeBody && typeof challengeBody === "object"
        ? (challengeBody as { challenge?: unknown }).challenge
        : null;
    if (!isUuid(challengeId) || !isValidBase64Field(challenge)) {
        throw new Error("Auth challenge response was invalid");
    }

    if ((challengeBody as { version?: unknown }).version !== 3) {
        throw new Error("Unsupported auth challenge protocol version");
    }

    const proof = signAuthChallenge(secret, serverUrl, challengeId, challenge);
    const authResponse = await fetchImpl(`${serverUrl}/v1/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            version: 3,
            publicKey: Buffer.from(proof.publicKey).toString("base64"),
            challengeId,
            signature: Buffer.from(proof.signature).toString("base64"),
        }),
    });
    if (!authResponse.ok) throw new Error(`Auth failed with status ${authResponse.status}`);

    const authBody = await readBoundedSeedJson(authResponse);
    const token = authBody && typeof authBody === "object"
        && (authBody as { success?: unknown }).success === true
        && typeof (authBody as { token?: unknown }).token === "string"
        ? (authBody as { token: string }).token
        : null;
    if (!isCredentialToken(token)) throw new Error("Auth response did not contain a valid token");

    // Direct key authentication intentionally returns an ordinary credential.
    // Complete the same terminal-pairing path used by the CLI to obtain a
    // separate, purpose-bound credential for machine RPC registration. Never
    // weaken the relay's purpose check by reusing the ordinary token.
    const pairingKeyPair = tweetnacl.box.keyPair();
    const pairingPublicKey = Buffer.from(pairingKeyPair.publicKey).toString("base64");
    const pairingRequestBody = { publicKey: pairingPublicKey, supportsV2: true as const };
    const pairingRequest = await fetchImpl(`${serverUrl}/v1/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pairingRequestBody),
    });
    if (!pairingRequest.ok) {
        throw new Error(`Seed pairing request failed with status ${pairingRequest.status}`);
    }
    const pairingRequestResult = await readBoundedSeedJson(pairingRequest);
    if (!pairingRequestResult
        || typeof pairingRequestResult !== "object"
        || (pairingRequestResult as { state?: unknown }).state !== "requested") {
        throw new Error("Seed pairing request response was invalid");
    }

    const encryptedSecret = libsodiumEncryptForPublicKey(secret, pairingKeyPair.publicKey);
    const pairingApproval = await fetchImpl(`${serverUrl}/v1/auth/response`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            publicKey: pairingPublicKey,
            response: Buffer.from(encryptedSecret).toString("base64"),
        }),
    });
    if (!pairingApproval.ok) {
        throw new Error(`Seed pairing approval failed with status ${pairingApproval.status}`);
    }
    const pairingApprovalResult = await readBoundedSeedJson(pairingApproval);
    if (!pairingApprovalResult
        || typeof pairingApprovalResult !== "object"
        || (pairingApprovalResult as { success?: unknown }).success !== true) {
        throw new Error("Seed pairing approval response was invalid");
    }

    const pairingPoll = await fetchImpl(`${serverUrl}/v1/auth/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pairingRequestBody),
    });
    if (!pairingPoll.ok) {
        throw new Error(`Seed pairing result failed with status ${pairingPoll.status}`);
    }
    const pairingPollResult = await readBoundedSeedJson(pairingPoll);
    const encryptedResponse = pairingPollResult
        && typeof pairingPollResult === "object"
        && (pairingPollResult as { state?: unknown }).state === "authorized"
        ? (pairingPollResult as { response?: unknown }).response
        : null;
    if (!isEncryptedPairingResponse(encryptedResponse)) {
        throw new Error("Seed pairing result response was invalid");
    }

    const paired = decryptPairingCredentials(encryptedResponse, pairingKeyPair.secretKey);
    if (!paired
        || !isCredentialToken(paired.token)
        || !isCredentialToken(paired.rpcRegistrationToken)
        || paired.response.length !== secret.length
        || !crypto.timingSafeEqual(Buffer.from(paired.response), Buffer.from(secret))) {
        throw new Error("Seed pairing credentials were invalid");
    }
    return {
        token: paired.token,
        rpcRegistrationToken: paired.rpcRegistrationToken,
    };
}

export async function seedEnvironment(name: string): Promise<void> {
    const envDir = getEnvironmentDir(name);
    const config = readEnvironmentConfig(name);
    const serverUrl = `http://localhost:${config.serverPort}`;

    try {
        const res = await fetch(`${serverUrl}/`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
    } catch {
        throw new Error(`Server not reachable at ${serverUrl}. Start it first: yarn env:server`);
    }

    // The CLI owns daemon lifecycle and authenticates its local control plane.
    // Never inspect or signal a PID copied from daemon.state.json here.
    stopEnvironmentDaemon(envDir, config);

    const secret = crypto.randomBytes(32);
    const { token, rpcRegistrationToken } = await authenticateSeedClient(serverUrl, secret);
    const secretBase64 = Buffer.from(secret).toString("base64");

    const cliHome = path.join(envDir, "cli", "home");
    ensurePrivateDirectory(ENVIRONMENTS_ROOT, cliHome);

    const accessKeyPath = path.join(cliHome, "access.key");
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        accessKeyPath,
        JSON.stringify({ secret: secretBase64, token, rpcRegistrationToken }, null, 2) + "\n",
    );

    const settingsPath = path.join(cliHome, "settings.json");
    atomicWritePrivateFile(
        ENVIRONMENTS_ROOT,
        settingsPath,
        JSON.stringify(
            {
                schemaVersion: 2,
                onboardingCompleted: true,
                machineId: crypto.randomUUID(),
            },
            null,
            2,
        ) + "\n",
    );

    const daemonEnv = mergeClientEnvironment(
        process.env,
        buildClientEnvVars(envDir, config.serverPort, config.expoPort),
    );
    delete daemonEnv.CLAUDECODE;

    const idleBin = path.join(REPO_ROOT, "packages", "idle-cli", "bin", "idle.mjs");
    const daemon = spawn(process.execPath, [idleBin, "daemon", "start"], {
        env: daemonEnv,
        stdio: "ignore",
        detached: true,
    });
    daemon.unref();

    const machineRegistered = await waitFor(async () => {
        const res = await fetch(`${serverUrl}/v1/machines`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const machines = (await res.json()) as unknown[];
        return machines.length > 0;
    }, 10_000, "machine registration").then(() => true, () => false);

    console.log(`  Seeded: credentials written, daemon ${machineRegistered ? "registered" : "starting"}`);
}

export function stopEnvironment(name: string): void {
    const envDir = getEnvironmentDir(name);
    const config = readEnvironmentConfig(name);
    let killed = 0;
    const failures: string[] = [];

    for (const service of ["server", "web"] as const) {
        try {
            if (stopManagedService(envDir, service)) {
                console.log(`Stopped verified ${service} process.`);
                killed++;
            }
        } catch (error) {
            failures.push((error as Error).message);
        }
    }

    if (stopEnvironmentDaemon(envDir, config)) killed++;

    if (failures.length > 0) {
        throw new Error(`One or more managed processes were not signaled:\n- ${failures.join("\n- ")}`);
    }

    if (killed === 0) {
        console.log(`No running services found for "${name}".`);
    } else {
        console.log("");
        console.log(`Environment "${name}" is down. Stopped ${killed} process(es).`);
    }
}

export function removeEnvironment(name: string): void {
    const envDir = getEnvironmentDir(name);
    assertSafeManagedPath(ENVIRONMENTS_ROOT, envDir);
    const currentConfig = readCurrentConfig();
    if (currentConfig?.current === name && lstatIfPresent(CURRENT_ENV_PATH)) {
        removeManagedFile(CURRENT_ENV_PATH);
    }
    fs.rmSync(envDir, { recursive: true, force: true });
    console.log(`Removed environment: ${name}`);
}

// ============================================================================
// Commands
// ============================================================================

async function commandNew(opts?: { noSwitch?: boolean }): Promise<string> {
    return createEnvironment(opts);
}

function commandList() {
    const envs = listEnvironments();
    if (envs.length === 0) {
        console.log("No environments. Run `yarn env:new` to create one.");
        return;
    }

    const currentConfig = readCurrentConfig();
    const currentName = currentConfig?.current;

    console.log("Environments:");
    console.log("");
    for (const envName of envs) {
        const config = readEnvironmentConfig(envName);
        const isCurrent = envName === currentName;
        const marker = isCurrent ? " *" : "  ";

        const serverUp = isPortInUse(config.serverPort);
        const expoUp = isPortInUse(config.expoPort);

        const serverStatus = serverUp ? "running" : "stopped";
        const expoStatus = expoUp ? "running" : "stopped";

        const serverUrl = `http://localhost:${config.serverPort}`;
        const bundlerUrl = `http://localhost:${config.expoPort}`;
        const webAppUrl = bundlerUrl;

        console.log(`${marker} ${envName}`);
        console.log(`     Server:  ${serverUrl} (${serverStatus})`);
        console.log(`     Bundler: ${bundlerUrl} (${expoStatus})`);
        console.log(`     Web app: ${webAppUrl}`);
        console.log(`     Created: ${config.createdAt}`);
        console.log("");
    }
}

function commandUse(name: string) {
    try {
        readEnvironmentConfig(name);
    } catch {
        console.error(`Environment "${name}" not found.`);
        console.error(`Available: ${listEnvironments().join(", ") || "(none)"}`);
        process.exit(1);
    }
    writeCurrentConfig(name);
    console.log(`Switched to environment: ${name}`);
}

function commandRemove(name: string) {
    try {
        readEnvironmentConfig(name);
    } catch {
        console.error(`Environment "${name}" not found.`);
        process.exit(1);
    }
    removeEnvironment(name);
}

function commandCurrent() {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` or `yarn env:use <name>`.");
        process.exit(1);
    }
    const config = readEnvironmentConfig(currentConfig.current);
    const webAppUrl = `http://localhost:${config.expoPort}`;
    console.log(`\nServer:  http://localhost:${config.serverPort}`);
    console.log(`Bundler: http://localhost:${config.expoPort}`);
    console.log(`Web app: ${webAppUrl}`);
    console.log(`CLI: ${buildCliCommand()}`);
}

function commandRun(service: string, serviceArgs: string[] = []) {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }

    const envName = currentConfig.current;
    const envDir = getEnvironmentDir(envName);
    try {
        readEnvironmentConfig(envName);
    } catch {
        console.error(`Environment "${envName}" not found. Run \`yarn env:new\`.`);
        process.exit(1);
    }

    const config = readEnvironmentConfig(envName);
    const clientEnv = mergeClientEnvironment(
        process.env,
        buildClientEnvVars(envDir, config.serverPort, config.expoPort),
    );

    switch (service) {
        case "server": {
            console.log(`Starting server for environment "${envName}" on port ${config.serverPort}...`);
            const result = spawnSync(
                "yarn",
                ["standalone", "serve"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "idle-server"),
                    env: {
                        ...process.env,
                        ...buildServerEnvVars(envDir, config.serverPort, config.expoPort),
                    },
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "web": {
            console.log(`Starting web app for environment "${envName}" on port ${config.expoPort}...`);
            const result = spawnSync(
                "yarn",
                ["web", "--port", String(config.expoPort)],
                {
                    cwd: path.join(REPO_ROOT, "packages", "idle-app"),
                    // Expo treats `--web` as "open in browser". Disable that for env-managed runs.
                    env: { ...clientEnv, BROWSER: "none" },
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "ios": {
            console.log(`Starting iOS app for environment "${envName}"...`);
            const result = spawnSync(
                "yarn",
                ["ios"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "idle-app"),
                    env: clientEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "android": {
            console.log(`Starting Android app for environment "${envName}"...`);
            const result = spawnSync(
                "yarn",
                ["android"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "idle-app"),
                    env: clientEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "cli": {
            console.log(`Starting CLI for environment "${envName}"...`);
            const cliBin = path.join(REPO_ROOT, "packages", "idle-cli", "bin", "idle.mjs");
            const result = spawnSync(
                "node",
                [cliBin, ...serviceArgs],
                {
                    env: clientEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        default:
            console.error(`Unknown service: "${service}". Use: server, web, ios, android, cli`);
            process.exit(1);
    }
}

// ============================================================================
// env.sh builder
// ============================================================================

const SERVER_ONLY_ENV_KEYS = [
    "IDLE_MASTER_SECRET",
    "IDLE_AUTH_AUDIENCE",
    "IDLE_ACCOUNT_REGISTRATION_MODE",
    "IDLE_MAX_ACCOUNTS",
    "IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES",
    "IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS",
    "DATABASE_URL",
    "DATA_DIR",
    "PGLITE_DIR",
    "DB_PROVIDER",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_MAX_CONVERSATION_SECONDS",
    "REVENUECAT_API_KEY",
    "REVENUECAT_PROJECT_ID",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "IDLE_ADMIN_SECRET",
    "REDIS_URL",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "S3_HOST",
    "S3_PORT",
    "S3_PUBLIC_URL",
    "S3_REGION",
    "S3_USE_SSL",
    "METRICS_ENABLED",
    "METRICS_HOST",
    "METRICS_PORT",
    "IDLE_CORS_ORIGIN",
    "PUBLIC_URL",
    "IDLE_STATIC_DIR",
    "IDLE_INJECT_HTML_CONFIG",
    "HAPPY_STATIC_DIR",
    "HAPPY_INJECT_HTML_CONFIG",
] as const;

const CLIENT_BASE_ENV_KEYS = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "CI",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "GPG_TTY",
    "SSH_TTY",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
]);

const CLIENT_ENV_PASSTHROUGH_KEY = "IDLE_ENV_PASSTHROUGH";
const SERVER_ONLY_ENV_KEY_SET = new Set<string>(SERVER_ONLY_ENV_KEYS);

function requestedClientEnvironmentKeys(baseEnv: NodeJS.ProcessEnv): string[] {
    const raw = baseEnv[CLIENT_ENV_PASSTHROUGH_KEY];
    if (!raw) return [];
    if (raw.length > 4096) {
        throw new Error(`${CLIENT_ENV_PASSTHROUGH_KEY} is too long`);
    }

    const keys = [...new Set(raw.split(",").map(key => key.trim()).filter(Boolean))];
    if (keys.length > 64) {
        throw new Error(`${CLIENT_ENV_PASSTHROUGH_KEY} requests too many variables`);
    }
    for (const key of keys) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
            throw new Error(`${CLIENT_ENV_PASSTHROUGH_KEY} contains an invalid variable name`);
        }
    }
    return keys;
}

export function mergeClientEnvironment(
    baseEnv: NodeJS.ProcessEnv,
    clientEnv: Record<string, string>,
): Record<string, string | undefined> {
    const merged: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (
            typeof value === "string"
            && (CLIENT_BASE_ENV_KEYS.has(key) || /^LC_[A-Za-z0-9_]+$/.test(key))
        ) {
            merged[key] = value;
        }
    }
    for (const key of requestedClientEnvironmentKeys(baseEnv)) {
        const value = baseEnv[key];
        if (typeof value === "string" && !SERVER_ONLY_ENV_KEY_SET.has(key)) {
            merged[key] = value;
        }
    }
    Object.assign(merged, clientEnv);
    return merged;
}

export function buildServerEnvVars(
    envDir: string,
    serverPort: number,
    _expoPort: number,
    managedRoot = ENVIRONMENTS_ROOT,
): Record<string, string> {
    const masterSecret = ensureEnvironmentMasterSecret(managedRoot, envDir);

    return {
        IDLE_MASTER_SECRET: masterSecret,
        IDLE_AUTH_AUDIENCE: `http://localhost:${serverPort}`,
        PORT: String(serverPort),
        NODE_ENV: "development",
        DATA_DIR: path.join(envDir, "server"),
        PGLITE_DIR: path.join(envDir, "server", "pglite"),
        DATABASE_URL: "",
        METRICS_ENABLED: "false",
    };
}

export function buildClientEnvVars(
    envDir: string,
    serverPort: number,
    expoPort: number,
): Record<string, string> {
    const projectDir = path.join(envDir, "project");
    return {
        NODE_ENV: "development",
        EXPO_PUBLIC_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PUBLIC_IDLE_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PORT: String(expoPort),

        IDLE_SERVER_URL: `http://localhost:${serverPort}`,
        IDLE_WEBAPP_URL: `http://localhost:${expoPort}`,
        IDLE_HOME_DIR: path.join(envDir, "cli", "home"),
        IDLE_PROJECT_DIR: projectDir,
        IDLE_VARIANT: "dev",
        DEBUG: "1",
    };
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildEnvSh(
    name: string,
    envDir: string,
    serverPort: number,
    expoPort: number,
    managedRoot = ENVIRONMENTS_ROOT,
): string {
    // Validate/create the server secret, but never export it into a shell used
    // by app, CLI, daemon, or agent processes.
    ensureEnvironmentMasterSecret(managedRoot, envDir);
    const vars = buildClientEnvVars(envDir, serverPort, expoPort);
    const lines: string[] = [
        `# Idle Dev Environment: ${name}`,
        `# Generated by environments/environments.ts`,
        `# Public client selectors only. Use yarn env:* to launch managed`,
        `# processes with the safe inherited-environment allowlist.`,
        "",
        "# Keep relay credentials and server-only topology out of client processes.",
        `unset ${SERVER_ONLY_ENV_KEYS.join(" ")}`,
        "",
    ];

    lines.push("# App (Expo)");
    lines.push(`export NODE_ENV=${shellSingleQuote(vars.NODE_ENV)}`);
    lines.push(`export EXPO_PUBLIC_SERVER_URL=${shellSingleQuote(vars.EXPO_PUBLIC_SERVER_URL)}`);
    lines.push(`export EXPO_PUBLIC_IDLE_SERVER_URL=${shellSingleQuote(vars.EXPO_PUBLIC_IDLE_SERVER_URL)}`);
    lines.push(`export EXPO_PORT=${vars.EXPO_PORT}`);
    lines.push("");

    lines.push("# CLI");
    lines.push(`export IDLE_SERVER_URL=${shellSingleQuote(vars.IDLE_SERVER_URL)}`);
    lines.push(`export IDLE_WEBAPP_URL=${shellSingleQuote(vars.IDLE_WEBAPP_URL)}`);
    lines.push(`export IDLE_HOME_DIR=${shellSingleQuote(vars.IDLE_HOME_DIR)}`);
    lines.push(`export IDLE_PROJECT_DIR=${shellSingleQuote(vars.IDLE_PROJECT_DIR)}`);
    lines.push(`export IDLE_VARIANT=dev`);
    lines.push(`export DEBUG=1`);
    lines.push("");

    return lines.join("\n");
}

function buildCliCommand(): string {
    return `cd ${shellSingleQuote(REPO_ROOT)} && yarn env:cli`;
}

// ============================================================================
// Seed auth
// ============================================================================

async function commandSeed(targetName?: string) {
    const envName = targetName ?? readCurrentConfig()?.current;
    if (!envName) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }
    await seedEnvironment(envName);
}

// ============================================================================
// Up / Down
// ============================================================================

async function commandUp(template: Template, opts?: { noSwitch?: boolean }) {
    const envName = await createEnvironment(opts);
    const envDir = getEnvironmentDir(envName);
    const config = readEnvironmentConfig(envName);

    setEnvironmentTemplate(envName, template);
    await startEnvironmentServices(envName);

    // Seed if template requires it
    if (template === "authenticated-empty") {
        // Always rebuild CLI so the daemon binary matches this worktree
        console.log("Building CLI (needed for daemon)...");
        const clientEnv = mergeClientEnvironment(
            process.env,
            buildClientEnvVars(envDir, config.serverPort, config.expoPort),
        );
        const buildResult = spawnSync("yarn", ["build"], {
            cwd: path.join(REPO_ROOT, "packages", "idle-cli"),
            env: clientEnv,
            stdio: "inherit",
        });
        if (buildResult.status !== 0) {
            console.error("CLI build failed.");
            process.exit(1);
        }

        console.log("Seeding auth + starting daemon...");
        await seedEnvironment(envName);
    }

    // Print summary
    const finalConfig = readEnvironmentConfig(envName);
    console.log("");
    console.log(`Environment "${envName}" is up!`);
    console.log(`  Server: http://localhost:${config.serverPort}`);
    console.log(`  Web:    http://localhost:${config.expoPort}`);
    console.log(`  Project: ${finalConfig.projectPath}`);

    if (finalConfig.cliCommand) {
        console.log(`  CLI:    ${finalConfig.cliCommand}`);
    }

    console.log(`  Logs:   ${path.relative(process.cwd(), path.join(envDir, "server", "stdout.log"))}`);
    console.log(`          ${path.relative(process.cwd(), path.join(envDir, "web", "stdout.log"))}`);
    console.log(`  Stop:   yarn env:down`);
    console.log("");
}

function commandDown(targetName?: string) {
    const envName = targetName ?? readCurrentConfig()?.current;
    if (!envName) {
        console.error("No current environment. Nothing to stop.");
        process.exit(1);
    }
    stopEnvironment(envName);
}

// ============================================================================
// Tailscale
// ============================================================================

export function getTailscaleServeCommands(expoPort: number, serverPort: number): string[][] {
    for (const port of [expoPort, serverPort]) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`Invalid Tailscale Serve target port: ${port}`);
        }
    }
    return [
        ["serve", "--bg", String(expoPort)],
        ["serve", "--bg", "--https=8443", String(serverPort)],
    ];
}

export function buildTailscaleAccessConfig(hostname: string): TailscaleAccessConfig {
    const hostnameIsValid = hostname.length <= 253
        && hostname.split(".").every(label => (
            label.length >= 1
            && label.length <= 63
            && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
        ));
    if (!hostnameIsValid) {
        throw new Error("Invalid Tailscale hostname");
    }

    const normalizedHostname = hostname.toLowerCase();
    const webOrigin = `https://${normalizedHostname}`;
    const serverUrl = `https://${normalizedHostname}:8443`;
    return {
        webOrigin,
        serverUrl,
        clientEnv: {
            EXPO_PUBLIC_SERVER_URL: serverUrl,
            EXPO_PUBLIC_IDLE_SERVER_URL: serverUrl,
        },
        serverEnv: {
            IDLE_CORS_ORIGIN: webOrigin,
            IDLE_AUTH_AUDIENCE: serverUrl,
            PUBLIC_URL: serverUrl,
        },
    };
}

function recordValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Fail closed when either node HTTPS port is already owned by a different
 * local service. `tailscale serve` updates one handler at a time, but would
 * still replace an unrelated root handler on the same port.
 */
export function assertTailscaleServeTargetsAvailable(
    status: unknown,
    hostname: string,
    expoPort: number,
    serverPort: number,
): void {
    buildTailscaleAccessConfig(hostname);
    getTailscaleServeCommands(expoPort, serverPort);
    const root = recordValue(status);
    if (!root) throw new Error("Invalid Tailscale Serve status");
    const tcp = root.TCP === undefined ? {} : recordValue(root.TCP);
    const web = root.Web === undefined ? {} : recordValue(root.Web);
    if (!tcp || !web) throw new Error("Invalid Tailscale Serve status");

    for (const [httpsPort, targetPort] of [[443, expoPort], [8443, serverPort]] as const) {
        const tcpEntry = tcp[String(httpsPort)];
        const candidateKeys = httpsPort === 443
            ? [hostname, `${hostname}:443`]
            : [`${hostname}:${httpsPort}`];
        const matchingWebEntries = candidateKeys
            .filter(key => web[key] !== undefined)
            .map(key => web[key]);
        const webEntry = matchingWebEntries.length === 1
            ? recordValue(matchingWebEntries[0])
            : null;
        const isUnused = tcpEntry === undefined && matchingWebEntries.length === 0;
        if (isUnused) continue;

        const tcpConfig = recordValue(tcpEntry);
        const handlers = webEntry && recordValue(webEntry.Handlers);
        const rootHandler = handlers && recordValue(handlers["/"]);
        const expectedProxy = `http://127.0.0.1:${targetPort}`;
        if (
            !tcpConfig || tcpConfig.HTTPS !== true ||
            matchingWebEntries.length !== 1 ||
            !rootHandler || rootHandler.Proxy !== expectedProxy
        ) {
            throw new Error(
                `Tailscale HTTPS port ${httpsPort} has an existing handler; refusing to replace it.`,
            );
        }
    }
}

async function commandTailscale() {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }

    const config = readEnvironmentConfig(currentConfig.current);
    const envDir = getEnvironmentDir(currentConfig.current);
    ensureEnvironmentMasterSecret(ENVIRONMENTS_ROOT, envDir);

    // Get tailscale hostname
    let hostname: string;
    try {
        const statusJson = execText("tailscale", ["status", "--self", "--json"]);
        const status = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
        const dnsName = status.Self?.DNSName;
        if (typeof dnsName !== "string") throw new Error("Missing Tailscale DNS name");
        hostname = dnsName.replace(/\.$/, "");
        buildTailscaleAccessConfig(hostname);
    } catch {
        console.error("Failed to get Tailscale hostname. Is Tailscale running?");
        process.exit(1);
    }

    const access = buildTailscaleAccessConfig(hostname);
    try {
        const serveStatus = JSON.parse(execText("tailscale", ["serve", "status", "--json"])) as unknown;
        assertTailscaleServeTargetsAvailable(
            serveStatus,
            hostname,
            config.expoPort,
            config.serverPort,
        );
        for (const args of getTailscaleServeCommands(config.expoPort, config.serverPort)) {
            execFileSync("tailscale", args, { stdio: "inherit" });
        }
    } catch (error) {
        console.error(`Failed to configure tailnet-only Tailscale Serve: ${(error as Error).message}`);
        process.exit(1);
    }

    // Expo substitutes EXPO_PUBLIC_* values when the web process starts, and
    // the server resolves CORS at boot. Restart only Idle's two owned managed
    // services so remote browsers receive the exact tailnet server URL while
    // unrelated Tailscale Serve handlers and the authenticated daemon remain.
    try {
        const stoppedServer = stopManagedService(envDir, "server");
        const stoppedWeb = stopManagedService(envDir, "web");
        if (stoppedServer || stoppedWeb) {
            await waitFor(
                () => !isPortInUse(config.serverPort) && !isPortInUse(config.expoPort),
                10_000,
                "managed environment services to stop",
            );
        }
        await startEnvironmentServices(currentConfig.current, access);
    } catch {
        console.error("Tailscale Serve was configured, but Idle services could not be restarted for remote access.");
        process.exit(1);
    }

    console.log("");
    console.log(`Tailnet-only Tailscale Serve active for "${currentConfig.current}":`);
    console.log("");
    console.log(`  Web:    https://${hostname}`);
    console.log(`  Server: https://${hostname}:8443`);
    console.log("");
}

// ============================================================================
// CLI entry point
// ============================================================================

async function main(): Promise<void> {
    const [subcommand, ...args] = process.argv.slice(2);

    switch (subcommand) {
        case "new": {
            const noSwitch = args.includes("--no-switch");
            await commandNew({ noSwitch });
            break;
        }
        case "list":
            commandList();
            break;
        case "use":
            if (!args[0]) {
                console.error("Usage: yarn env:use <name>");
                process.exit(1);
            }
            commandUse(args[0]);
            break;
        case "remove":
            if (!args[0]) {
                console.error("Usage: yarn env:remove <name>");
                process.exit(1);
            }
            commandRemove(args[0]);
            break;
        case "current":
            commandCurrent();
            break;
        case "run":
            if (!args[0]) {
                console.error("Usage: yarn env:server | yarn env:web | yarn env:cli");
                process.exit(1);
            }
            commandRun(args[0], args.slice(1));
            break;
        case "seed":
            await commandSeed();
            break;
        case "up": {
            const templateIdx = args.indexOf("--template");
            const template = templateIdx !== -1 ? args[templateIdx + 1] : undefined;
            if (!template || !VALID_TEMPLATES.includes(template as Template)) {
                console.error(`Usage: yarn env:up --template <${VALID_TEMPLATES.join("|")}>`);
                process.exit(1);
            }
            const noSwitch = args.includes("--no-switch");
            await commandUp(template as Template, { noSwitch });
            break;
        }
        case "down":
            commandDown(args[0]);
            break;
        case "tailscale":
            await commandTailscale();
            break;
        default:
            console.log(`Idle Environment Manager

Usage:
  yarn env:up --template <t>  Create + start everything (templates: ${VALID_TEMPLATES.join(", ")})
  yarn env:up:authenticated   Create + start everything with the authenticated template
  yarn env:down               Stop all services for current environment

  yarn env:new              Create a new isolated dev environment
  yarn env:list             List all environments with status
  yarn env:use <name>       Switch to a different environment
  yarn env:remove <name>    Delete an environment
  yarn env:current          Print current environment connection details
  yarn env:seed             Seed auth for CLI + web (requires server running)

  yarn env:server           Start the server (current environment)
  yarn env:web              Start the web app (current environment)
  yarn env:ios              Start the iOS app (current environment)
  yarn env:android          Start the Android app (current environment)
  yarn env:cli              Start the CLI (current environment)

  yarn env:tailscale        Share server + web privately inside your tailnet
`);
            if (subcommand && subcommand !== "--help" && subcommand !== "-h") {
                process.exit(1);
            }
    }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
