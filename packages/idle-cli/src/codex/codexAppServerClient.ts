/**
 * Codex App Server Client — drives the v2 JSON-RPC protocol exposed by
 * `codex app-server`.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Reference: codex-rs/app-server/README.md in the openai/codex repo.
 *
 * The SDK package wraps non-interactive `codex exec` and does not expose the
 * bidirectional app-server approval protocol. This client owns that protocol
 * so mobile clients can route exec, patch, and MCP approval requests.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn as crossSpawn, sync as crossSpawnSync } from 'cross-spawn';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { Transform, type TransformCallback } from 'node:stream';
import { logger } from '@/ui/logger';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    DeleteConversationParams,
    DeleteConversationResponse,
    ForkConversationParams,
    ForkConversationResponse,
    ReadConversationParams,
    ReadConversationResponse,
    RollbackConversationParams,
    RollbackConversationResponse,
    InjectItemsParams,
    InjectItemsResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    Thread,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import {
    createIsolatedCodexRuntimeHome,
    type IsolatedCodexRuntimeHome,
} from './isolatedRuntimeHome';
import packageJson from '../../package.json';

const CODEX_PROVIDER_MAX_JSON_LINE_BYTES = 32 * 1024 * 1024;
const CODEX_CREDENTIAL_MAX_BYTES = 16 * 1024;
const CODEX_LOGIN_STATUS_MAX_BYTES = 64 * 1024;
const CODEX_LOGIN_TIMEOUT_MS = 15_000;
const CODEX_VERSION_MAX_BYTES = 64 * 1024;
const CODEX_VERSION_TIMEOUT_MS = 15_000;
const CODEX_FILE_AUTH_CONFIG = 'cli_auth_credentials_store="file"';
const CODEX_VERSION_ENV_KEYS = new Set([
    'PATH',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'LC_COLLATE',
    'LC_MONETARY',
    'LC_NUMERIC',
    'LC_TIME',
    'LC_PAPER',
    'LC_NAME',
    'LC_ADDRESS',
    'LC_TELEPHONE',
    'LC_MEASUREMENT',
    'LC_IDENTIFICATION',
]);

type CodexSandboxAuthenticationErrorCode =
    | 'CODEX_SANDBOX_KEYRING_AUTH_UNSUPPORTED'
    | 'CODEX_SANDBOX_AUTH_UNAVAILABLE'
    | 'CODEX_SANDBOX_ACCESS_TOKEN_REJECTED';

export class CodexSandboxAuthenticationError extends Error {
    readonly code: CodexSandboxAuthenticationErrorCode;

    constructor(code: CodexSandboxAuthenticationErrorCode, message: string) {
        super(message);
        this.name = 'CodexSandboxAuthenticationError';
        this.code = code;
    }
}

class BoundedLineTransform extends Transform {
    private currentLineBytes = 0;

    constructor(private readonly maxLineBytes: number) {
        super();
    }

    override _transform(
        chunk: Buffer | string,
        encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        let offset = 0;

        while (offset < bytes.length) {
            const newline = bytes.indexOf(0x0a, offset);
            const end = newline === -1 ? bytes.length : newline;
            this.currentLineBytes += end - offset;
            if (this.currentLineBytes > this.maxLineBytes) {
                callback(new Error('Provider JSON line exceeded the configured byte limit'));
                return;
            }
            if (newline === -1) break;
            this.currentLineBytes = 0;
            offset = newline + 1;
        }

        callback(null, bytes);
    }
}

const CODEX_CHILD_ENV_KEYS = new Set([
    // Process discovery and platform basics.
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'FORCE_COLOR',
    'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    // Codex configuration and its in-scope provider credentials.
    'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
    // Explicit networking and certificate configuration.
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
    // Diagnostics. NODE_OPTIONS is deliberately excluded because it can load code.
    'RUST_LOG', 'RUST_BACKTRACE',
]);

/**
 * Limit the Codex subprocess to operational settings and Codex-scoped secrets.
 * The long-lived Idle process can contain unrelated provider, cloud, GitHub, and
 * application credentials that a spawned agent must not inherit by default.
 */
export function buildCodexChildEnvironment(
    sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(sourceEnv)) {
        if (typeof value !== 'string') continue;
        if (CODEX_CHILD_ENV_KEYS.has(key) || /^LC_[A-Z0-9_]+$/.test(key)) {
            env[key] = value;
        }
    }
    return env;
}

function stripCodexCredentials(environment: Record<string, string>): void {
    delete environment.CODEX_ACCESS_TOKEN;
    delete environment.CODEX_API_KEY;
    delete environment.OPENAI_API_KEY;
}

function trustedCodexEnvironment(codexHome: string): Record<string, string> {
    const environment = buildCodexChildEnvironment();
    stripCodexCredentials(environment);
    environment.CODEX_HOME = codexHome;
    environment.CODEX_SQLITE_HOME = codexHome;
    return environment;
}

export function hasExplicitCodexSandboxCredential(
    environment: NodeJS.ProcessEnv = process.env,
): boolean {
    return Boolean(
        environment.CODEX_ACCESS_TOKEN?.trim()
        || environment.CODEX_API_KEY?.trim()
        || environment.OPENAI_API_KEY?.trim(),
    );
}

export function hasKeyringBackedChatGptLogin(sourceHome: string): boolean {
    try {
        const result = crossSpawnSync('codex', ['login', 'status'], {
            encoding: 'utf8',
            env: trustedCodexEnvironment(sourceHome),
            maxBuffer: CODEX_LOGIN_STATUS_MAX_BYTES,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: CODEX_LOGIN_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error || result.status !== 0) return false;

        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        const output = `${stdout}\n${stderr}`;
        if (Buffer.byteLength(output, 'utf8') > CODEX_LOGIN_STATUS_MAX_BYTES) return false;
        return output
            .split(/\r?\n/)
            .some((line) => /^Logged in using ChatGPT\s*$/i.test(line.trim()));
    } catch {
        return false;
    }
}

function bootstrapCodexAccessToken(runtimeHome: string, accessToken: string): void {
    try {
        const result = crossSpawnSync('codex', [
            'login',
            '--with-access-token',
            '-c',
            CODEX_FILE_AUTH_CONFIG,
        ], {
            encoding: 'utf8',
            input: accessToken,
            env: trustedCodexEnvironment(runtimeHome),
            maxBuffer: CODEX_LOGIN_STATUS_MAX_BYTES,
            stdio: ['pipe', 'ignore', 'ignore'],
            timeout: CODEX_LOGIN_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error || result.status !== 0) {
            throw new Error('Codex access token bootstrap subprocess failed');
        }
    } catch {
        throw new CodexSandboxAuthenticationError(
            'CODEX_SANDBOX_ACCESS_TOKEN_REJECTED',
            'Codex access token bootstrap failed. Verify CODEX_ACCESS_TOKEN and try again.',
        );
    }
}

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

type RawTurnCompletion = {
    turnId: string | null;
    status: string | null;
    source: string;
};

type ProviderFailure = {
    kind: 'provider-failed';
    code?: string;
};

const CODEX_ERROR_INFO_CODES: Readonly<Record<string, string>> = Object.freeze({
    contextWindowExceeded: 'context_window_exceeded',
    sessionBudgetExceeded: 'session_budget_exceeded',
    usageLimitExceeded: 'usage_limit',
    serverOverloaded: 'server_overloaded',
    cyberPolicy: 'policy_blocked',
    httpConnectionFailed: 'http_connection_failed',
    responseStreamConnectionFailed: 'response_stream_connection_failed',
    internalServerError: 'internal_server_error',
    unauthorized: 'authentication_required',
    badRequest: 'bad_request',
    threadRollbackFailed: 'thread_rollback_failed',
    sandboxError: 'sandbox_error',
    responseStreamDisconnected: 'response_stream_disconnected',
    responseTooManyFailedAttempts: 'response_too_many_failed_attempts',
    activeTurnNotSteerable: 'active_turn_not_steerable',
    other: 'provider_error',
});

function readBoundedFailureCode(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
        return null;
    }
    return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

function classifyCodexErrorInfo(value: unknown): string | null {
    if (typeof value === 'string') {
        return CODEX_ERROR_INFO_CODES[value] ?? null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    for (const variant of Object.keys(value)) {
        const code = CODEX_ERROR_INFO_CODES[variant];
        if (code) return code;
    }
    return null;
}

/** Keep provider-owned diagnostics out of events while preserving a safe reason code. */
function classifyProviderFailure(error: unknown): ProviderFailure {
    const failure: ProviderFailure = { kind: 'provider-failed' };
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return failure;
    }

    const record = error as Record<string, unknown>;
    const mappedCodexErrorCode = classifyCodexErrorInfo(record.codexErrorInfo);
    if (mappedCodexErrorCode) {
        return { ...failure, code: mappedCodexErrorCode };
    }
    const codexErrorInfo = record.codexErrorInfo && typeof record.codexErrorInfo === 'object'
        && !Array.isArray(record.codexErrorInfo)
        ? record.codexErrorInfo as Record<string, unknown>
        : null;
    const additionalDetails = record.additionalDetails && typeof record.additionalDetails === 'object'
        && !Array.isArray(record.additionalDetails)
        ? record.additionalDetails as Record<string, unknown>
        : null;
    const candidates = [
        record.code,
        codexErrorInfo?.code,
        additionalDetails?.code,
        record.type,
        codexErrorInfo?.type,
        additionalDetails?.type,
    ];

    for (const candidate of candidates) {
        const code = readBoundedFailureCode(candidate);
        if (code) {
            return { ...failure, code };
        }
    }
    return failure;
}

function classifyProviderStderr(text: string): ProviderFailure['code'] | null {
    const normalized = text.toLowerCase();
    if (normalized.includes("you've hit your usage limit")) return 'usage_limit';
    if (normalized.includes('rate limit')) return 'rate_limit';
    if (normalized.includes('authentication required') || normalized.includes('not logged in')) {
        return 'authentication_required';
    }
    return null;
}

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

/**
 * Check that `codex app-server` is available.
 */
function parseCodexCliVersion(version: string): { major: number; minor: number; patch: number } | null {
    const match = version.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
        return null;
    }
    return { major, minor, patch };
}

function buildCodexVersionEnvironment(
    sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of CODEX_VERSION_ENV_KEYS) {
        const value = sourceEnv[key];
        if (typeof value === 'string') {
            environment[key] = value;
        }
    }
    return environment;
}

function readCodexCliVersion(): { major: number; minor: number; patch: number } | null {
    try {
        const result = crossSpawnSync('codex', ['--version'], {
            encoding: 'utf8',
            env: buildCodexVersionEnvironment(),
            maxBuffer: CODEX_VERSION_MAX_BYTES,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: CODEX_VERSION_TIMEOUT_MS,
            windowsHide: true,
        });
        if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
            return null;
        }
        if (Buffer.byteLength(result.stdout, 'utf8') > CODEX_VERSION_MAX_BYTES) {
            return null;
        }
        return parseCodexCliVersion(result.stdout.trim());
    } catch {
        return null;
    }
}

export function isCodexCliAvailable(): boolean {
    return readCodexCliVersion() !== null;
}

function isAppServerAvailable(): boolean {
    const version = readCodexCliVersion();
    if (!version) {
        return false;
    }
    const { major, minor } = version;
    // app-server available in recent versions
    return major > 0 || minor >= 100;
}

function isGoalActionsAvailable(): boolean {
    const version = readCodexCliVersion();
    if (!version) {
        return false;
    }
    const { major, minor } = version;
    // thread/goal/set and thread/goal/clear are present in Codex 0.140+.
    return major > 0 || minor >= 140;
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        const changeRecord = change as Record<string, unknown>;
        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as Record<string, unknown>
            : null;
        const type = typeof changeRecord.type === 'string'
            ? changeRecord.type
            : (typeof kind?.type === 'string' ? kind.type : null);
        const movePath = changeRecord.move_path ?? kind?.move_path ?? null;

        if (kind) {
            entry.kind = kind;
        } else if (type) {
            entry.kind = { type, move_path: movePath };
        }

        const diff = typeof changeRecord.diff === 'string'
            ? changeRecord.diff
            : (typeof changeRecord.unified_diff === 'string' ? changeRecord.unified_diff : null);
        if (diff !== null) {
            entry.diff = diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add;
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify;
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete;
        }

        const content = typeof changeRecord.content === 'string' ? changeRecord.content : null;
        if (type === 'add' && content !== null) {
            entry.add = { content };
        }
        if (type === 'delete' && content !== null) {
            entry.delete = { content };
        }

        const oldContent = typeof changeRecord.oldContent === 'string'
            ? changeRecord.oldContent
            : (typeof changeRecord.old_content === 'string' ? changeRecord.old_content : null);
        const newContent = typeof changeRecord.newContent === 'string'
            ? changeRecord.newContent
            : (typeof changeRecord.new_content === 'string' ? changeRecord.new_content : null);
        if ((oldContent !== null || newContent !== null) && type !== 'add' && type !== 'delete') {
            entry.modify = {
                old_content: oldContent ?? '',
                new_content: newContent ?? '',
            };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class CodexAppServerClient {
    private static readonly PROCESS_TERMINATION_GRACE_MS = 2_000;
    private static readonly PROCESS_FORCE_KILL_GRACE_MS = 1_000;

    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private stdoutGuard: BoundedLineTransform | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    private isolatedRuntimeHome: IsolatedCodexRuntimeHome | null = null;
    private expectedProcessExitEpoch: number | null = null;
    public sandboxEnabled = false;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    // A completion event only resolves once we have seen task_started for this turn.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        turnId: string | null;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    private pendingRawCompletion: RawTurnCompletion | null = null;
    private rawFinalAnswerTurnIds = new Set<string>();
    private rawAgentMessageItemIds = new Set<string>();
    private providerFailureCode: ProviderFailure['code'] | null = null;
    private providerStderrTail = '';

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;
    private unexpectedExitHandler: (() => void) | null = null;

    constructor(sandboxConfig?: SandboxConfig) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    supportsGoalActions(): boolean {
        return isGoalActionsAvailable();
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    setUnexpectedExitHandler(handler: () => void): void {
        this.unexpectedExitHandler = handler;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'thread/goal/updated'
            || method === 'thread/goal/cleared'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private rememberBounded(set: Set<string>, value: string, limit = 1_024): void {
        if (set.has(value)) return;
        set.add(value);
        if (set.size > limit) {
            const oldest = set.values().next().value;
            if (typeof oldest === 'string') set.delete(oldest);
        }
    }

    private isTerminalFailureStatus(status: string | null): boolean {
        return status === 'failed' || status === 'error';
    }

    private isAbortedStatus(status: string | null): boolean {
        return status === 'cancelled'
            || status === 'canceled'
            || status === 'aborted'
            || status === 'interrupted';
    }

    private completeRawTurn(
        completion: RawTurnCompletion,
        aborted: boolean,
        failure?: ProviderFailure,
    ): void {
        if (this.pendingRawCompletion === completion) {
            this.pendingRawCompletion = null;
        }

        const { turnId, status, source } = completion;
        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this.rememberBounded(this.completedTurnIds, turnId);
        }

        this.eventHandler?.({
            type: aborted ? 'turn_aborted' : 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(failure ? { failure } : {}),
        });
        this.providerFailureCode = null;
        this.providerStderrTail = '';

        // Consumers must observe the terminal event before sendTurnAndWait resolves.
        this.tryResolvePendingTurn(aborted, turnId, source);
        if (!turnId || this._turnId === turnId) {
            this._turnId = null;
        }
    }

    private emitRawAgentMessage(turnId: string | null, item: Record<string, unknown>): void {
        const itemId = typeof item.id === 'string' ? item.id : null;
        if (itemId && this.rawAgentMessageItemIds.has(itemId)) {
            return;
        }
        if (itemId) {
            this.rememberBounded(this.rawAgentMessageItemIds, itemId);
        }

        const text = typeof item.text === 'string' ? item.text : '';
        const phase = typeof item.phase === 'string' ? item.phase : null;
        if (text.length > 0) {
            this.eventHandler?.({
                type: 'agent_message',
                message: text,
                ...(itemId ? { item_id: itemId } : {}),
                ...(turnId ? { turn_id: turnId } : {}),
                ...(phase ? { phase } : {}),
            });
        }

        if (phase !== 'final_answer') return;
        if (turnId) {
            this.rememberBounded(this.rawFinalAnswerTurnIds, turnId);
        }

        const pending = this.pendingRawCompletion;
        if (pending && (!pending.turnId || !turnId || pending.turnId === turnId)) {
            this.completeRawTurn(pending, false);
            return;
        }

        if (this.pendingTurnCompletion) {
            this.emitRawTurnCompletion(turnId, 'completed', null, 'item/completed:final_answer');
        }
    }

    private async reconcileRawTurnCompletion(completion: RawTurnCompletion): Promise<void> {
        const threadId = this._threadId;
        if (!threadId) {
            if (this.pendingRawCompletion === completion) {
                this.completeRawTurn(completion, false);
            }
            return;
        }

        try {
            const result = await this.request('thread/read', {
                threadId,
                includeTurns: true,
            } satisfies ReadConversationParams, 5_000) as ReadConversationResponse;
            if (this.pendingRawCompletion !== completion) return;

            const turns = Array.isArray(result?.thread?.turns) ? result.thread.turns : [];
            const turn = completion.turnId
                ? turns.find(candidate => candidate.id === completion.turnId)
                : turns.at(-1);
            for (const item of turn?.items ?? []) {
                if (item.type === 'agentMessage') {
                    this.emitRawAgentMessage(turn?.id ?? completion.turnId, item);
                }
            }
        } catch {
            if (this.pendingRawCompletion === completion) {
                logger.debug('[CodexAppServer] Raw turn reconciliation unavailable', {
                    source: completion.source,
                });
            }
        }

        if (this.pendingRawCompletion === completion) {
            this.completeRawTurn(completion, false);
        }
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }

        const completion: RawTurnCompletion = { turnId, status, source };
        if (this.isTerminalFailureStatus(status)) {
            const failure = classifyProviderFailure(error);
            this.completeRawTurn(completion, true, {
                ...failure,
                ...(failure.code ? {} : (this.providerFailureCode ? { code: this.providerFailureCode } : {})),
            });
            return;
        }
        if (this.isAbortedStatus(status)) {
            this.completeRawTurn(completion, true);
            return;
        }

        if (turnId && this.rawFinalAnswerTurnIds.has(turnId)) {
            this.completeRawTurn(completion, false);
            return;
        }

        if (!this.pendingTurnCompletion) {
            this.completeRawTurn(completion, false);
            return;
        }

        if (this.pendingRawCompletion
            && (!turnId || !this.pendingRawCompletion.turnId || this.pendingRawCompletion.turnId === turnId)) {
            return;
        }
        this.pendingRawCompletion = completion;
        void this.reconcileRawTurnCompletion(completion);
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            this.pendingRawCompletion = null;
            if (turnId) {
                this._turnId = turnId;
            }
            this.markPendingTurnStarted(turnId);
            this.eventHandler?.({
                type: 'task_started',
                ...(turnId ? { turn_id: turnId } : {}),
            });
            return true;
        }

        if (method === 'turn/completed') {
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            const statusType = params?.status?.type;
            if (statusType === 'idle' && this.pendingTurnCompletion) {
                this.emitRawTurnCompletion(this._turnId, 'completed', null, method);
            }
            return true;
        }

        if (method === 'thread/goal/updated') {
            const threadId = typeof params?.threadId === 'string'
                ? params.threadId
                : (typeof params?.goal?.threadId === 'string' ? params.goal.threadId : undefined);
            const turnId = typeof params?.turnId === 'string' ? params.turnId : null;
            this.eventHandler?.({
                type: 'thread_goal_updated',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
                ...(turnId ? { turn_id: turnId, turnId } : {}),
                goal: params?.goal,
            });
            return true;
        }

        if (method === 'thread/goal/cleared') {
            const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
            this.eventHandler?.({
                type: 'thread_goal_cleared',
                ...(threadId ? { thread_id: threadId, threadId } : {}),
            });
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            this.emitRawAgentMessage(this.extractTurnId(params) ?? this._turnId, item);
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        if (!isAppServerAvailable()) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  idle claude',
            );
        }

        let command = 'codex';
        let args = ['app-server', '--listen', 'stdio://'];
        let sandboxApiKey: string | null = null;
        let sandboxAccessTokenBootstrapped = false;
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled) {
            if (process.platform === 'win32') {
                throw new Error(
                    'Codex sandboxing is not supported on Windows. Disable the configured sandbox explicitly to continue without it.',
                );
            }

            this.isolatedRuntimeHome = createIsolatedCodexRuntimeHome();
            try {
                const explicitAccessToken = process.env.CODEX_ACCESS_TOKEN?.trim() || null;
                const explicitApiKey = process.env.CODEX_API_KEY?.trim()
                    || process.env.OPENAI_API_KEY?.trim()
                    || null;
                if (
                    explicitAccessToken
                    && Buffer.byteLength(explicitAccessToken, 'utf8') > CODEX_CREDENTIAL_MAX_BYTES
                ) {
                    throw new Error('The configured Codex access token exceeds the supported size');
                }
                if (explicitApiKey && Buffer.byteLength(explicitApiKey, 'utf8') > CODEX_CREDENTIAL_MAX_BYTES) {
                    throw new Error('The configured Codex API key exceeds the supported size');
                }
                if (explicitAccessToken) {
                    bootstrapCodexAccessToken(this.isolatedRuntimeHome.path, explicitAccessToken);
                    sandboxAccessTokenBootstrapped = true;
                    args = [...args, '-c', CODEX_FILE_AUTH_CONFIG];
                } else if (explicitApiKey) {
                    sandboxApiKey = explicitApiKey;
                } else {
                    if (hasKeyringBackedChatGptLogin(this.isolatedRuntimeHome.sourceHome)) {
                        throw new CodexSandboxAuthenticationError(
                            'CODEX_SANDBOX_KEYRING_AUTH_UNSUPPORTED',
                            'Codex is signed in with ChatGPT through the OS keyring, but that consumer login cannot be delegated to Idle\'s isolated sandbox. Use `idle codex --no-sandbox` explicitly, or configure CODEX_ACCESS_TOKEN (Business/Enterprise), CODEX_API_KEY, or OPENAI_API_KEY.',
                        );
                    }
                    throw new CodexSandboxAuthenticationError(
                        'CODEX_SANDBOX_AUTH_UNAVAILABLE',
                        'Sandboxed Codex requires CODEX_ACCESS_TOKEN (Business/Enterprise), CODEX_API_KEY, or OPENAI_API_KEY. To use a consumer ChatGPT login, run `codex login` and then `idle codex --no-sandbox` explicitly.',
                    );
                }
            } catch (error) {
                this.isolatedRuntimeHome.cleanup();
                this.isolatedRuntimeHome = null;
                throw error;
            }

            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd(), {
                    additionalWritePaths: [this.isolatedRuntimeHome.path],
                    additionalDenyReadPaths: [this.isolatedRuntimeHome.sourceHome],
                    includeDefaultAgentStatePaths: false,
                });
                const wrapped = await wrapForMcpTransport('codex', args);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                const cleanup = this.sandboxCleanup;
                this.sandboxCleanup = null;
                this.sandboxEnabled = false;
                if (cleanup) {
                    try { await cleanup(); } catch { /* preserve the initialization error */ }
                }
                this.isolatedRuntimeHome?.cleanup();
                this.isolatedRuntimeHome = null;
                const reason = error instanceof Error ? error.message : String(error);
                logger.warn('[CodexAppServer] Failed to initialize the required sandbox.');
                throw new Error(`Codex sandbox initialization failed: ${reason}`, { cause: error });
            }
        }

        const env = buildCodexChildEnvironment();
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            stripCodexCredentials(env);
            env.CODEX_SANDBOX = 'seatbelt';
            env.CODEX_HOME = this.isolatedRuntimeHome!.path;
        }

        logger.debug('[CodexAppServer] Starting provider process', {
            argumentCount: args.length,
            sandboxEnabled: this.sandboxEnabled,
        });

        try {
            const epoch = ++this.processEpoch;
            let unexpectedFailureReported = false;
            const reportUnexpectedFailure = () => {
                if (unexpectedFailureReported) return;
                unexpectedFailureReported = true;
                try {
                    this.unexpectedExitHandler?.();
                } catch {
                    logger.debug('[CodexAppServer] Unexpected-exit handler failed');
                }
            };
            const rejectPendingForProcess = (reason: string) => {
                for (const [id, req] of this.pending) {
                    if (req.epoch !== epoch) continue;
                    req.reject(new Error(`${reason} while waiting for ${req.method}`));
                    this.pending.delete(id);
                }
                this.pendingRawCompletion = null;
                this.resolvePendingTurn(true);
            };
            // Use cross-spawn so npm-installed wrappers (codex.cmd / codex.ps1) resolve on Windows.
            const proc = crossSpawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env,
                windowsHide: true,
            });
            this.process = proc;

            proc.on('error', () => {
                logger.debug('[CodexAppServer] Process error');
                if (this.process !== proc || this.processEpoch !== epoch) return;
                const wasConnected = this.connected;
                this.connected = false;
                rejectPendingForProcess('Codex provider process failed');
                if (wasConnected) reportUnexpectedFailure();
                try {
                    proc.kill('SIGTERM');
                } catch { /* process may never have started */ }
            });

            proc.on('exit', (code, signal) => {
                logger.debug('[CodexAppServer] Process exited', {
                    exitedCleanly: code === 0,
                    signaled: signal !== null,
                });
                // Ignore stale process exits from prior generations during reconnect.
                if (this.process !== proc || this.processEpoch !== epoch) {
                    logger.debug('[CodexAppServer] Ignoring stale process exit');
                    return;
                }
                const expectedExit = this.expectedProcessExitEpoch === epoch;
                this.process = null;
                this.readline?.close();
                this.readline = null;
                proc.stdout?.unpipe(this.stdoutGuard ?? undefined);
                this.stdoutGuard?.destroy();
                this.stdoutGuard = null;
                this.connected = false;
                // Reject all pending requests
                for (const [id, req] of this.pending) {
                    if (req.epoch !== epoch) continue;
                    req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                    this.pending.delete(id);
                }
                // Resolve pending turn completion (treat as abort)
                this.pendingRawCompletion = null;
                this.resolvePendingTurn(true);
                if (!expectedExit) {
                    reportUnexpectedFailure();
                }
            });

            // Pipe stderr for debug logging
            proc.stderr?.on('data', (chunk: Buffer) => {
                if (this.process !== proc || this.processEpoch !== epoch) return;
                const text = chunk.toString();
                if (text.trim()) {
                    const classifierInput = this.providerStderrTail + text;
                    this.providerFailureCode ??= classifyProviderStderr(classifierInput);
                    this.providerStderrTail = classifierInput.slice(-128);
                    logger.debug('[CodexAppServer] Provider stderr received', {
                        bytes: Buffer.byteLength(text, 'utf8'),
                    });
                }
            });

            // Bound each frame before readline can accumulate it in memory.
            const stdoutGuard = new BoundedLineTransform(CODEX_PROVIDER_MAX_JSON_LINE_BYTES);
            this.stdoutGuard = stdoutGuard;
            stdoutGuard.once('error', () => {
                if (this.process !== proc || this.processEpoch !== epoch) return;
                logger.warn('[CodexAppServer] Provider output exceeded the transport limit');
                const wasConnected = this.connected;
                this.connected = false;
                proc.stdout?.unpipe(stdoutGuard);
                this.readline?.close();
                this.readline = null;
                if (this.stdoutGuard === stdoutGuard) this.stdoutGuard = null;
                rejectPendingForProcess('Codex provider output exceeded the transport limit');
                if (wasConnected) reportUnexpectedFailure();
                try {
                    proc.kill('SIGTERM');
                } catch { /* process may already be gone */ }
            });
            proc.stdout!.pipe(stdoutGuard);
            this.readline = createInterface({ input: stdoutGuard });
            this.readline.on('error', () => {
                // The input guard owns fail-closed teardown for transport errors.
                logger.debug('[CodexAppServer] Readline input closed after transport failure');
            });
            this.readline.on('line', (line) => {
                if (this.process !== proc || this.processEpoch !== epoch) return;
                this.handleLine(line, epoch);
            });

            // Perform initialize handshake
            const initParams: InitializeParams = {
                clientInfo: {
                    name: 'idle-codex',
                    title: 'Idle Codex Client',
                    version: packageJson.version,
                },
                capabilities: {
                    experimentalApi: true,
                },
            };
            await this.request('initialize', initParams);
            this.notify('initialized');
            if (this.sandboxEnabled) {
                if (sandboxAccessTokenBootstrapped) {
                    try {
                        const account = await this.request('account/read', {
                            refreshToken: false,
                        }) as { account?: unknown } | null;
                        if (!account || typeof account !== 'object' || !account.account) {
                            throw new CodexSandboxAuthenticationError(
                                'CODEX_SANDBOX_ACCESS_TOKEN_REJECTED',
                                'Codex access token bootstrap did not produce an authenticated app-server session.',
                            );
                        }
                    } finally {
                        this.isolatedRuntimeHome?.clearBootstrapAuth();
                    }
                } else if (sandboxApiKey) {
                    await this.request('account/login/start', {
                        type: 'apiKey',
                        apiKey: sandboxApiKey,
                    });
                }
                if (!sandboxAccessTokenBootstrapped) {
                    // API-key login writes a bootstrap auth.json. App-server has
                    // already cached it, so remove it before any model-controlled
                    // command can inspect the disposable runtime home.
                    this.isolatedRuntimeHome?.clearBootstrapAuth();
                }
            }
            this.connected = true;
            logger.debug('[CodexAppServer] Connected and initialized');
        } catch (error) {
            try {
                await this.disconnectInternal();
            } catch {
                logger.debug('[CodexAppServer] Failed to clean up after connect error');
            }
            throw error;
        }
    }

    private waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
        if (proc.exitCode != null || proc.signalCode != null) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (exited: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                proc.off('exit', onExit);
                proc.off('close', onExit);
                resolve(exited);
            };
            const onExit = () => finish(true);
            const timer = setTimeout(() => {
                finish(proc.exitCode != null || proc.signalCode != null);
            }, timeoutMs);

            proc.once('exit', onExit);
            proc.once('close', onExit);
        });
    }

    private async terminateProcess(proc: ChildProcess): Promise<void> {
        const gracefulExit = this.waitForProcessExit(
            proc,
            CodexAppServerClient.PROCESS_TERMINATION_GRACE_MS,
        );

        try {
            proc.stdin?.end();
            proc.kill('SIGTERM');
        } catch { /* process may already be gone */ }

        if (await gracefulExit) return;

        const forcedExit = this.waitForProcessExit(
            proc,
            CodexAppServerClient.PROCESS_FORCE_KILL_GRACE_MS,
        );
        try {
            proc.kill('SIGKILL');
        } catch { /* process may have exited between checks */ }

        if (!await forcedExit) {
            throw new Error('Codex app-server did not exit after SIGKILL');
        }
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process && !this.sandboxCleanup && !this.isolatedRuntimeHome) return;

        const proc = this.process;
        const epoch = this.processEpoch;
        logger.debug('[CodexAppServer] Disconnecting');

        this.readline?.close();
        this.readline = null;
        proc?.stdout?.unpipe(this.stdoutGuard ?? undefined);
        this.stdoutGuard?.destroy();
        this.stdoutGuard = null;

        let disconnectError: Error | null = null;
        if (proc) {
            this.expectedProcessExitEpoch = epoch;
            try {
                await this.terminateProcess(proc);
            } catch {
                disconnectError = new Error('Codex app-server did not exit after SIGKILL');
            }
        }

        this.process = null;
        this.connected = false;
        this._turnId = null;
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        this.pendingRawCompletion = null;
        this.rawFinalAnswerTurnIds.clear();
        this.rawAgentMessageItemIds.clear();
        this.rawFileChangesByItemId.clear();
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        // Resolve pending turn completion (treat as abort)
        this.resolvePendingTurn(true);

        const sandboxCleanup = this.sandboxCleanup;
        this.sandboxCleanup = null;
        if (sandboxCleanup) {
            try {
                await sandboxCleanup();
            } catch {
                disconnectError ??= new Error('Codex sandbox cleanup failed');
            }
        }
        this.sandboxEnabled = false;
        const runtimeHome = this.isolatedRuntimeHome;
        this.isolatedRuntimeHome = null;
        try {
            runtimeHome?.cleanup();
        } catch {
            disconnectError ??= new Error('Disposable Codex runtime cleanup failed');
        }
        if (this.expectedProcessExitEpoch === epoch) {
            this.expectedProcessExitEpoch = null;
        }

        logger.debug('[CodexAppServer] Disconnected');
        if (disconnectError) throw disconnectError;
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
        ephemeral?: boolean;
    }): Promise<{ threadId: string; model: string }> {
        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
            ephemeral: opts.ephemeral ?? null,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started');
        return { threadId: result.thread.id, model: result.model };
    }

    async deleteThread(opts?: {
        threadId?: string;
    }): Promise<DeleteConversationResponse> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to delete.');
        }

        const params: DeleteConversationParams = { threadId };
        const result = await this.request('thread/delete', params) as DeleteConversationResponse;
        if (threadId === this._threadId) {
            this.clearThreadState();
        }
        return result;
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed');
        return { threadId: result.thread.id, model: result.model };
    }

    async forkThread(opts: {
        threadId: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string; thread: Thread }> {
        const defaults = this.threadDefaults ?? {};
        const params: ForkConversationParams = {
            threadId: opts.threadId,
            model: opts.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            ephemeral: false,
            threadSource: null,
        };

        const result = await this.request('thread/fork', params) as ForkConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts.model ?? defaults.model,
            cwd: opts.cwd ?? defaults.cwd,
            approvalPolicy: opts.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts.sandbox ?? defaults.sandbox,
            mcpServers: opts.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread forked');
        return { threadId: result.thread.id, model: result.model, thread: result.thread };
    }

    async readThread(opts: {
        threadId: string;
        includeTurns?: boolean;
    }): Promise<ReadConversationResponse> {
        const params: ReadConversationParams = {
            threadId: opts.threadId,
            includeTurns: opts.includeTurns ?? true,
        };
        return await this.request('thread/read', params) as ReadConversationResponse;
    }

    async rollbackThread(opts: {
        threadId: string;
        numTurns: number;
    }): Promise<RollbackConversationResponse> {
        const params: RollbackConversationParams = {
            threadId: opts.threadId,
            numTurns: opts.numTurns,
        };
        return await this.request('thread/rollback', params) as RollbackConversationResponse;
    }

    async injectItems(opts: {
        threadId: string;
        items: unknown[];
    }): Promise<InjectItemsResponse> {
        const params: InjectItemsParams = {
            threadId: opts.threadId,
            items: opts.items,
        };
        return await this.request('thread/inject_items', params) as InjectItemsResponse;
    }

    async setGoal(opts: {
        threadId: string;
        objective: string;
        status?: ThreadGoalSetParams['status'];
        tokenBudget?: number | null;
    }): Promise<ThreadGoalSetResponse> {
        const params: ThreadGoalSetParams = {
            threadId: opts.threadId,
            objective: opts.objective,
            ...(opts.status !== undefined ? { status: opts.status } : {}),
            ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        };
        return await this.request('thread/goal/set', params) as ThreadGoalSetResponse;
    }

    async clearGoal(opts: {
        threadId: string;
    }): Promise<ThreadGoalClearResponse> {
        const params: ThreadGoalClearParams = {
            threadId: opts.threadId,
        };
        return await this.request('thread/goal/clear', params) as ThreadGoalClearResponse;
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: !!threadId });
        await this.connect();

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect');
            this._threadId = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, _source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from a *different* turn.
        // We use turn ID matching instead of the `started` flag because Codex
        // can skip the turn/started notification entirely for fast turns,
        // which would cause us to discard a valid turn/completed and hang forever.
        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug('[CodexAppServer] Ignoring a stale turn-completion notification');
            return;
        }

        this.resolvePendingTurn(aborted);
    }

    private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion()) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        const hadActiveTurn = this.hasPendingTurnCompletion();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const settled = await this.waitForTurnCompletion(gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion) {
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
            });
        }
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }
        this.providerFailureCode = null;
        this.providerStderrTail = '';

        const extraInputItems = opts?.extraInputItems ?? [];
        const input: InputItem[] = [];
        if (prompt.length > 0 || extraInputItems.length === 0) {
            input.push({ type: 'text', text: prompt });
        }
        input.push(...extraInputItems);

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && turnId.length > 0) {
            this._turnId = turnId;
            if (this.pendingTurnCompletion) {
                this.pendingTurnCompletion.turnId = turnId;
            }
        }
    }

    /** Default timeout for waiting on turn completion (ms). 10 minutes. */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        extraInputItems?: InputItem[];
        turnTimeoutMs?: number;
    }): Promise<{ aborted: boolean }> {
        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed now
            // (harmlessly, since pendingTurnCompletion is null at this point).
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                turnId: null,
            };

            timer = setTimeout(() => {
                if (this.pendingTurnCompletion) {
                    logger.warn(`[CodexAppServer] Turn timed out after ${timeoutMs}ms — treating as abort`);
                    this.resolvePendingTurn(true);
                }
            }, timeoutMs);
        });

        try {
            await this.sendTurn(prompt, opts);
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.pendingTurnCompletion = null;
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        return { aborted };
    }

    async interruptTurn(): Promise<void> {
        if (!this._threadId) return;
        if (!this._turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        const params: InterruptConversationParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params);
            } catch {
                // Ignore if no turn is active
                logger.debug('[CodexAppServer] interruptTurn failed (may be expected)');
            } finally {
                this.pendingInterrupt = null;
            }
        };
        this.pendingInterrupt = doInterrupt();
        return this.pendingInterrupt;
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    clearThreadState(): void {
        logger.debug('[CodexAppServer] Clearing thread state');
        this.resolvePendingTurn(true);
        this._threadId = null;
        this._turnId = null;
        this.threadDefaults = null;
        this.completedTurnIds.clear();
        this.pendingRawCompletion = null;
        this.rawFinalAnswerTurnIds.clear();
        this.rawAgentMessageItemIds.clear();
        this.rawFileChangesByItemId.clear();
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug('[CodexAppServer] Sending provider request');
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug('[CodexAppServer] Sending provider notification');
    }

    private respond(id: number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug('[CodexAppServer] Sending provider response');
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug(`[CodexAppServer] Ignored non-JSON line (length=${line.length})`);
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug('[CodexAppServer] Ignoring stale provider response');
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    const providerCode = typeof msg.error.code === 'number'
                        ? ` (code=${msg.error.code})`
                        : '';
                    pending.reject(new Error(`${pending.method}: provider RPC failed${providerCode}`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.handleServerRequest(msg.id, msg.method, msg.params).catch(() => {
                logger.debug('[CodexAppServer] Server request handling failed');
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message type', {
            hasMethod: typeof msg.method === 'string',
            fieldCount: Object.keys(msg).length,
        });
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug('[CodexAppServer] Unknown server request', {
            methodLength: method.length,
        });
        this.respond(id, {});
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch {
                logger.debug('[CodexAppServer] Approval handler failed');
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        if (method === 'error') {
            const failure = classifyProviderFailure(params?.error);
            this.providerFailureCode ??= failure.code ?? null;
            logger.debug('[CodexAppServer] Provider error notification received', {
                hasSafeCode: Boolean(failure.code),
            });
            return;
        }

        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                if (msg.type === 'task_started') {
                    this.markPendingTurnStarted(msg.turn_id ?? msg.turnId ?? null);
                }
                // Fire event handler first (so consumer processes the event)
                this.eventHandler?.(msg);
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const turnId = msg.turn_id ?? msg.turnId ?? null;
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    );
                    this._turnId = null;
                }
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug('[CodexAppServer] Raw notification handled');
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug('[CodexAppServer] Lifecycle notification handled');
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        // MCP lifecycle payloads can contain provider-owned diagnostics. Persist
        // only bounded structural metadata; surface actionable errors through the UI.
        if (method === 'mcpServer/startupStatus/updated') {
            logger.debug('[CodexAppServer] MCP server startup status updated', {
                parameterFieldCount: params && typeof params === 'object'
                    ? Object.keys(params).length
                    : 0,
            });
            return;
        }

        logger.debug('[CodexAppServer] Unrecognized notification received', {
            methodLength: method.length,
        });
    }
}
