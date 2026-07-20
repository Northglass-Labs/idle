/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import {
    getOperationalAgentState,
    getOperationalSessionMetadata,
    storage,
} from './storage';
import { MachineMetadataSchema, type MachineMetadata } from './storageTypes';
import { base64DecodedLength, exceedsUtf8ByteLimit, FILE_LOAD_LIMITS, maxBase64Length, resolveFileResponseLimit } from './fileLoadPolicy';
import {
    ClaudeForkSessionResultSchema,
    ClaudeListRewindPointsResultSchema,
    CodexForkThreadResultSchema,
    CodexListRewindPointsResultSchema,
    CommandResponseSchema,
    KillSessionResponseSchema,
    MachineMetadataUpdateResponseSchema,
    ReadFileResponseSchema,
    SpawnSessionResultSchema,
    StopDaemonResponseSchema,
    SwitchResponseSchema,
    WriteFileResponseSchema,
    parseRpcResult,
} from './opsRpcSchemas';

// Strict type definitions for all operations

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

interface SessionGoalActionRequest {
    action: 'clear' | 'stop' | 'edit';
    objective?: string;
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

export interface SessionGitDiffRequest {
    path: string;
    mode: 'working' | 'head';
    timeout?: number;
    maxBytes?: number;
}

export interface SessionGitDiffResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
interface SessionReadFileRequest {
    path: string;
    maxBytes: number;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
    maxBytes: number;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'requestToApproveCodexNativeSandbox' }
    | { type: 'error'; errorMessage: string };

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'codex' | 'claude' | 'gemini' | 'openclaw';
    /** The user's in-app Co-Authored-By preference for this session. */
    commitAttribution?: boolean;
    /**
     * If set, the daemon spawns the agent with `--resume <id>` so the new
     * Idle session attaches to a pre-existing on-disk Claude conversation
     * file. Used by the session fork / duplicate flow.
     */
    resumeClaudeSessionId?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so the new Idle
     * session attaches to an app-server thread created by fork / duplicate.
     */
    resumeCodexThreadId?: string;
    /** Idle session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Idle message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
    /** Explicit consent to use Codex's own sandbox when keychain auth cannot enter Idle isolation. */
    codexProviderNativeSandboxApproved?: boolean;
}

// Options for forking a Claude session on a machine
export interface ClaudeForkSessionOptions {
    machineId: string;
    /** Working directory of the source session — used to derive the Claude project dir. */
    directory: string;
    /** Source Claude session UUID (Session.metadata.claudeSessionId on the parent). */
    claudeSessionId: string;
}

export type ClaudeForkSessionResult =
    | { type: 'success'; newClaudeSessionId: string }
    | { type: 'error'; errorMessage: string };

export interface ClaudeRewindPoint {
    uuid: string;
    text: string;
    timestamp: number;
}

export type ClaudeListRewindPointsResult =
    | { type: 'success'; points: ClaudeRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface CodexForkThreadOptions {
    machineId: string;
    /** Working directory of the source session, passed to Codex thread/fork. */
    directory: string;
    /** Source Codex app-server thread id (Session.metadata.codexThreadId). */
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const {
        machineId,
        directory,
        approvedNewDirectoryCreation = false,
        agent,
        commitAttribution,
        resumeClaudeSessionId,
        resumeCodexThreadId,
        parentSessionId,
        forkedFromMessageId,
        codexProviderNativeSandboxApproved,
    } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            agent?: 'codex' | 'claude' | 'gemini' | 'openclaw',
            commitAttribution?: boolean,
            resumeClaudeSessionId?: string,
            resumeCodexThreadId?: string,
            parentSessionId?: string,
            forkedFromMessageId?: string,
            codexProviderNativeSandboxApproved?: boolean,
        }>(
            machineId,
            'spawn-idle-session',
            {
                type: 'spawn-in-directory',
                directory,
                approvedNewDirectoryCreation,
                agent,
                commitAttribution,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                parentSessionId,
                forkedFromMessageId,
                codexProviderNativeSandboxApproved,
            }
        );
        return parseRpcResult(SpawnSessionResultSchema, result);
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/**
 * Copy the source session's Claude JSONL on the daemon machine and return
 * the new Claude session UUID. The caller then spawns a fresh Idle session
 * with `resumeClaudeSessionId` set to that UUID to attach a new Idle
 * session row to the copied conversation.
 */
export async function claudeForkSession(options: ClaudeForkSessionOptions): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-fork-session',
            { directory, claudeSessionId },
        );
        return parseRpcResult(ClaudeForkSessionResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

/**
 * Read the on-disk Claude JSONL on the daemon machine and return user-text
 * messages with their underlying claudeUuid + timestamp. Disk is the
 * source of truth for the rewind picker — server-side envelopes miss
 * claudeUuid for any user message that travelled via the legacy
 * `sentFrom: 'web'` path.
 */
export async function claudeListRewindPoints(
    options: ClaudeForkSessionOptions,
): Promise<ClaudeListRewindPointsResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeListRewindPointsResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-list-rewind-points',
            { directory, claudeSessionId },
        );
        return parseRpcResult(ClaudeListRewindPointsResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list rewind points',
        };
    }
}

/**
 * Same as claudeForkSession, but truncates the copied JSONL right after the
 * line with `cutAfterUuid` (keeping the chosen message as the last entry,
 * dropping every line after — including the agent's response). Use this
 * for "rewind to message N and try again" flows. Daemon hard-fails if the
 * UUID isn't present in the source — never silently produces a
 * non-truncated copy.
 */
export async function claudeDuplicateSession(
    options: ClaudeForkSessionOptions & { cutAfterUuid: string },
): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId, cutAfterUuid } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
            cutAfterUuid: string;
        }>(
            machineId,
            'claude-duplicate-session',
            { directory, claudeSessionId, cutAfterUuid },
        );
        return parseRpcResult(ClaudeForkSessionResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate session',
        };
    }
}

export async function codexForkThread(options: CodexForkThreadOptions): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-fork-thread',
            { directory, codexThreadId },
        );
        return parseRpcResult(CodexForkThreadResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork Codex thread',
        };
    }
}

export async function codexDuplicateThread(
    options: CodexForkThreadOptions & { cutAfterItemId: string },
): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId, cutAfterItemId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
            cutAfterItemId: string;
        }>(
            machineId,
            'codex-duplicate-thread',
            { directory, codexThreadId, cutAfterItemId },
        );
        return parseRpcResult(CodexForkThreadResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate Codex thread',
        };
    }
}

export async function codexListRewindPoints(
    options: CodexForkThreadOptions,
): Promise<CodexListRewindPointsResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexListRewindPointsResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-list-rewind-points',
            { directory, codexThreadId },
        );
        return parseRpcResult(CodexListRewindPointsResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list Codex rewind points',
        };
    }
}

export async function machineResumeSession(options: ResumeSessionOptions & { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> {
    const { machineId, sessionId, model, permissionMode } = options;
    const session = storage.getState().sessions[sessionId];
    const metadata = getOperationalSessionMetadata(session?.metadata);
    const hasResumeIdentity = isNonEmptyString(metadata?.claudeSessionId)
        || isNonEmptyString(metadata?.codexThreadId);
    if (metadata?.machineId !== machineId || !hasResumeIdentity) {
        return {
            type: 'error',
            errorMessage: 'Session metadata is not authenticated for this operation',
        };
    }

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, { sessionId: string; model?: string; permissionMode?: string }>(
            machineId,
            'resume-idle-session',
            { sessionId, model, permissionMode },
        );
        return parseRpcResult(SpawnSessionResultSchema, result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
        };
    }
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${encodeURIComponent(machineId)}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        return { success: false, message: `Server error: ${response.status}` };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return parseRpcResult(StopDaemonResponseSchema, result);
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return parseRpcResult(CommandResponseSchema, result);
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error('Machine encryption is unavailable');
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const rawResult = await apiSocket.emitWithAck<unknown>(
            'machine-update-metadata', {
                machineId,
                metadata: encryptedMetadata,
                expectedVersion: currentVersion
            },
        );
        const result = parseRpcResult(MachineMetadataUpdateResponseSchema, rawResult);

        if (result.result === 'success') {
            return {
                version: result.version,
                metadata: result.metadata
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version;
            const latestMetadata = parseRpcResult(
                MachineMetadataSchema,
                await machineEncryption.decryptRaw(result.metadata),
            );

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error('Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Abort the current session operation
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    // ABORT-1: optimistically clear the thinking state so the "Conjuring…"
    // indicator and Abort button disappear the instant the user taps Abort,
    // rather than waiting for the CLI's stop update (which can lag, or on a
    // flaky link never arrive). A later server update re-syncs the truth.
    storage.getState().updateSessionThinking(sessionId, false);
    await apiSocket.sessionRPC(sessionId, 'abort', {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    const agentState = getOperationalAgentState(
        storage.getState().sessions[sessionId]?.agentState,
    );
    if (!agentState?.requests?.[id]) {
        throw new Error('Session permission state is not authenticated for this operation');
    }
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, updatedInput };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    const agentState = getOperationalAgentState(
        storage.getState().sessions[sessionId]?.agentState,
    );
    if (!agentState?.requests?.[id]) {
        throw new Error('Session permission state is not authenticated for this operation');
    }
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return parseRpcResult(SwitchResponseSchema, response);
}

/**
 * Request an agent-owned goal action.
 */
export async function sessionGoalAction(
    sessionId: string,
    action: SessionGoalActionRequest['action'],
    objective?: string,
): Promise<void> {
    const session = storage.getState().sessions[sessionId];
    const metadata = getOperationalSessionMetadata(session?.metadata);
    const goal = getOperationalAgentState(session?.agentState)?.agentGoalStatus;
    const expectedSourceSessionId = goal?.source === 'claude'
        ? metadata?.claudeSessionId
        : goal?.source === 'codex'
            ? metadata?.codexThreadId
            : null;
    if (
        goal?.status !== 'active'
        || !isNonEmptyString(goal.sourceSessionId)
        || goal.sourceSessionId !== expectedSourceSessionId
    ) {
        throw new Error('Session goal state is not authenticated for this operation');
    }

    await apiSocket.sessionRPC(sessionId, 'goal-action', {
        action,
        ...(objective !== undefined ? { objective } : {}),
    } satisfies SessionGoalActionRequest);
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return parseRpcResult(CommandResponseSchema, response);
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Fetch one repository file's diff without placing its path in shell text.
 */
export async function sessionGitDiff(
    sessionId: string,
    request: SessionGitDiffRequest,
): Promise<SessionGitDiffResponse> {
    const maxBytes = resolveFileResponseLimit(
        request.maxBytes,
        FILE_LOAD_LIMITS.explicitOpen.maxBytesPerResponse,
    );
    if (maxBytes === null) {
        return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'Invalid Git diff response limit' };
    }

    try {
        const rawResponse = await apiSocket.sessionRPC<unknown, SessionGitDiffRequest>(
            sessionId,
            'gitDiff',
            { ...request, maxBytes },
        );
        const response = parseRpcResult(CommandResponseSchema, rawResponse);
        if (
            response.success
            && (
                typeof response.stdout !== 'string'
                || typeof response.stderr !== 'string'
                || exceedsUtf8ByteLimit([response.stdout, response.stderr], maxBytes)
            )
        ) {
            return { success: false, stdout: '', stderr: '', exitCode: -1, error: 'Git diff response exceeded limit' };
        }
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: '',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(
    sessionId: string,
    path: string,
    requestedMaxBytes: number = FILE_LOAD_LIMITS.explicitOpen.maxBytesPerResponse,
): Promise<SessionReadFileResponse> {
    const maxBytes = resolveFileResponseLimit(requestedMaxBytes, FILE_LOAD_LIMITS.explicitOpen.maxBytesPerResponse);
    if (maxBytes === null) {
        return { success: false, error: 'Invalid file response limit' };
    }

    try {
        const request: SessionReadFileRequest = { path, maxBytes };
        const rawResponse = await apiSocket.sessionRPC<unknown, SessionReadFileRequest>(
            sessionId,
            'readFile',
            request
        );
        const response = parseRpcResult(ReadFileResponseSchema, rawResponse);
        if (
            response.success
            && (
                typeof response.content !== 'string'
                || response.content.length > maxBase64Length(maxBytes)
                || base64DecodedLength(response.content) > maxBytes
            )
        ) {
            return { success: false, error: 'File response exceeded limit' };
        }
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const rawResponse = await apiSocket.sessionRPC<unknown, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return parseRpcResult(WriteFileResponseSchema, rawResponse);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string,
    requestedMaxBytes: number = FILE_LOAD_LIMITS.fileSearch.maxOutputBytes,
): Promise<SessionRipgrepResponse> {
    const maxBytes = resolveFileResponseLimit(requestedMaxBytes, FILE_LOAD_LIMITS.fileSearch.maxOutputBytes);
    if (maxBytes === null) {
        return { success: false, error: 'Invalid file-list response limit' };
    }

    try {
        const request: SessionRipgrepRequest = { args, cwd, maxBytes };
        const rawResponse = await apiSocket.sessionRPC<unknown, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        const response = parseRpcResult(CommandResponseSchema, rawResponse);
        if (
            response.success
            && (
                typeof response.stdout !== 'string'
                || typeof response.stderr !== 'string'
                || exceedsUtf8ByteLimit([response.stdout, response.stderr], maxBytes)
            )
        ) {
            return { success: false, error: 'File-list response exceeded limit' };
        }
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const rawResponse = await apiSocket.sessionRPC<unknown, {}>(
            sessionId,
            'killSession',
            {}
        );
        return parseRpcResult(KillSessionResponseSchema, rawResponse);
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Archive a session by deactivating it on the server.
 * Use this when the CLI process is already dead and sessionKill can't reach it.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

type ClaudeForkSource = {
    kind?: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

// Forking source description used by forkAndSpawn.
export type ForkSource = ClaudeForkSource | CodexForkSource;

type ForkOptions = {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
};

/**
 * Two-step orchestrator for the session fork / duplicate flow:
 *   1. Ask the daemon to copy (and optionally truncate) the source Claude
 *      JSONL — returns a fresh Claude session UUID.
 *   2. Spawn a new Idle session on the same machine with
 *      `resumeClaudeSessionId` set to that UUID so `claude --resume` picks
 *      up the copied conversation.
 *
 * Lineage (parentSessionId, forkedFromMessageId) rides through the spawn
 * RPC into env vars, then into the new Idle session's metadata at start
 * — so the parent link survives without any server-side schema change.
 */
export async function forkAndSpawn(
    source: ForkSource,
    opts: ForkOptions = {},
): Promise<SpawnSessionResult> {
    const sourceSession = storage.getState().sessions[source.sessionId];
    const metadata = getOperationalSessionMetadata(sourceSession?.metadata);
    const commonCoordinatesMatch = metadata?.machineId === source.machineId
        && metadata.path === source.directory;
    const providerCoordinatesMatch = source.kind === 'codex'
        ? metadata?.flavor === 'codex'
            && metadata.codexThreadId === source.codexThreadId
        : metadata?.flavor !== 'codex'
            && metadata?.claudeSessionId === source.claudeSessionId;
    if (!commonCoordinatesMatch || !providerCoordinatesMatch) {
        return {
            type: 'error',
            errorMessage: 'Fork source metadata is not authenticated for this operation',
        };
    }

    if (source.kind === 'codex') {
        const forkResult = opts.cutAfterItemId
            ? await codexDuplicateThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
                cutAfterItemId: opts.cutAfterItemId,
            })
            : await codexForkThread({
                machineId: source.machineId,
                directory: source.directory,
                codexThreadId: source.codexThreadId,
            });

        if (forkResult.type !== 'success') {
            return { type: 'error', errorMessage: forkResult.errorMessage };
        }

        const spawnResult = await machineSpawnNewSession({
            machineId: source.machineId,
            directory: source.directory,
            agent: 'codex',
            approvedNewDirectoryCreation: false,
            resumeCodexThreadId: forkResult.newCodexThreadId,
            parentSessionId: source.sessionId,
            forkedFromMessageId: opts.forkedFromMessageId,
        });

        if (spawnResult.type === 'success') {
            try {
                await sync.refreshSessions();
            } catch {
                // Refresh is best-effort; broadcast sync will still hydrate.
            }
        }

        return spawnResult;
    }

    const forkResult = opts.cutAfterUuid
        ? await claudeDuplicateSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
            cutAfterUuid: opts.cutAfterUuid,
        })
        : await claudeForkSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
        });

    if (forkResult.type !== 'success') {
        return { type: 'error', errorMessage: forkResult.errorMessage };
    }

    const spawnResult = await machineSpawnNewSession({
        machineId: source.machineId,
        directory: source.directory,
        agent: 'claude',
        approvedNewDirectoryCreation: false,
        resumeClaudeSessionId: forkResult.newClaudeSessionId,
        parentSessionId: source.sessionId,
        forkedFromMessageId: opts.forkedFromMessageId,
    });

    // Pull the newly-created session row into local sync state before we
    // hand control back to the caller — otherwise router.replace into the
    // new session id races the broadcast and the app screams
    // "Session X not found" until the next sync tick lands.
    if (spawnResult.type === 'success') {
        try {
            await sync.refreshSessions();
        } catch {
            // Refresh is best-effort; the broadcast will still hydrate the
            // session shortly even if this fetch flaked.
        }
    }

    return spawnResult;
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionRipgrepResponse,
    SessionKillResponse
};
