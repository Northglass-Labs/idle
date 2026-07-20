import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient, isCodexCliAvailable } from './codexAppServerClient';
import type { ReasoningEffort } from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type PendingAttachment } from '@/utils/MessageQueue2';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startIdleServer } from '@/claude/utils/startIdleServer';
import { createIdleMcpBridgeConfig } from '@/claude/utils/createIdleMcpBridgeConfig';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession, UserMessage } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { resolveCodexExecutionPolicy } from './executionPolicy';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText, isCodexClearText } from './codexClearCommand';
import { downloadCodexFileEventAttachment } from './utils/attachmentEvents';
import { prepareCodexImageInputItems } from './utils/imageInput';
import { createSerialAsyncHandler } from './utils/serialAsyncHandler';
import { buildCodexThreadBackfillEnvelopes } from './utils/threadImageBackfill';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    type CodexEnhancedMode,
} from './codexPrompt';
import { discoverCodexSkillCommands } from './codexSkills';
import {
    codexGoalActionCapabilities,
    mapCodexGoalEventToAgentGoalStatus,
    parseCodexGoalActionParams,
    parseCodexGoalCommand,
    type CodexGoalCommand,
} from './codexGoalStatus';
import {
    archiveCodexSessionMetadata,
    handleUnexpectedCodexBackendExit,
    type CodexExitReason,
} from './runnerLifecycle';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function classifyLegacyCodexFailure(error: unknown): string | null {
    const errorRecord = error && typeof error === 'object' && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
    const codexErrorInfo = errorRecord?.codexErrorInfo;
    if (typeof codexErrorInfo === 'string') {
        const mapped: Readonly<Record<string, string>> = {
            usageLimitExceeded: 'usage_limit',
            unauthorized: 'authentication_required',
            contextWindowExceeded: 'context_window_exceeded',
            sessionBudgetExceeded: 'session_budget_exceeded',
            serverOverloaded: 'server_overloaded',
        };
        const code = mapped[codexErrorInfo];
        if (code) return code;
    }

    const candidates = [
        typeof error === 'string' ? error : null,
        typeof errorRecord?.message === 'string' ? errorRecord.message : null,
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const normalized = candidate.toLowerCase();
        if (normalized.includes('usage limit')) return 'usage_limit';
        if (normalized.includes('rate limit')) return 'rate_limit';
        if (normalized.includes('authentication required')
            || normalized.includes('not logged in')
            || normalized.includes('unauthorized')) {
            return 'authentication_required';
        }
    }
    return null;
}

export function describeCodexFailure(msg: any): string | null {
    const providerFailure = msg?.failure
        && typeof msg.failure === 'object'
        && !Array.isArray(msg.failure)
        && msg.failure.kind === 'provider-failed'
        ? msg.failure as Record<string, unknown>
        : null;
    const hasFailure = msg?.status === 'failed'
        || (msg?.error !== undefined && msg?.error !== null)
        || providerFailure !== null;
    if (!hasFailure) return null;
    const code = providerFailure?.code ?? classifyLegacyCodexFailure(msg.error);
    if (
        typeof code === 'string'
        && code.length > 0
        && code.length <= 64
        && /^[A-Za-z0-9._-]+$/.test(code)
    ) {
        return `Provider failure (${code})`;
    }
    return 'Provider reported a failed turn without details';
}

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_EFFORT: ReasoningEffort = 'medium';
const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'default';

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
}): Promise<void> {
    // Early check: ensure Codex CLI is installed before proceeding
    if (!isCodexCliAvailable()) {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36midle claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/Northglass-Labs/idle/issues`);
        process.exit(1);
    }
    logger.debug('[Codex] Using the configured machine identity');
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.IDLE_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.IDLE_FORKED_FROM_MESSAGE_ID;

    // Codex has its OWN sandbox enforcement (CodexAppServerClient executionPolicy),
    // distinct from @anthropic-ai/sandbox-runtime. The metadata claim is honest:
    // when sandboxConfig.enabled, Codex applies sandboxing via its own mechanism.
    // See docs/permission-resolution.md for cross-flavor classification semantics.
    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandboxEnforced: sandboxConfig,
        codexSandboxMode: opts.noSandbox ? 'provider-native' : 'idle-managed',
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
    });

    const skillCommands = await discoverCodexSkillCommands();
    if (skillCommands.length > 0) {
        metadata.skills = skillCommands;
        metadata.slashCommands = Array.from(new Set([...(metadata.slashCommands ?? []), ...skillCommands]));
    }

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.IDLE_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.IDLE_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.IDLE_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.IDLE_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.IDLE_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.IDLE_RECONNECT_AGENT_STATE_VERSION;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug('[START] Reconnecting to an existing Codex session');
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Declared before reconnection setup so session swaps can replace its client.
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug('[START] Reporting Codex session to daemon');
            const result = await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
            if (result.error) {
                logger.debug('[START] Failed to report Codex session to daemon (may not be running)');
            } else {
                logger.debug('[START] Reported Codex session to daemon');
            }
        } catch {
            logger.debug('[START] Failed to report Codex session to daemon (may not be running)');
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);

    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug('[Codex] File event received', {
            size: ev.size,
            hasMimeType: Boolean(ev.mimeType),
        });
        session.trackAttachmentDownload(downloadCodexFileEventAttachment(session, fileEvent));
    });

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel: string | undefined = DEFAULT_CODEX_MODEL;
    let currentEffort: ReasoningEffort | undefined = DEFAULT_CODEX_EFFORT;
    let currentAppendSystemPrompt: string | undefined = undefined;

    const resetCurrentModeDefaults = () => {
        currentPermissionMode = DEFAULT_CODEX_PERMISSION_MODE;
        currentModel = DEFAULT_CODEX_MODEL;
        currentEffort = DEFAULT_CODEX_EFFORT;
        currentAppendSystemPrompt = undefined;
        logger.debug('[Codex] Reset current mode defaults after abort');
    };

    // Valid Codex permission modes from remote messages. Matches the modes
    // the mobile UI exposes for Codex sessions (see modelModeOptions.ts:
    // getCodexPermissionModes) and mirrors the Gemini validation pattern at
    // runGemini.ts:222. Anything outside this set is silently ignored — the
    // previous code blindly cast `message.meta.permissionMode as PermissionMode`
    // at runtime, meaning a crafted value like `'totally_unsafe'` would be
    // accepted and then fall through to the `default` branch in
    // resolveCodexExecutionPolicy() — or worse, an attacker-chosen valid value
    // could escalate sandbox scope.
    const VALID_REMOTE_PERMISSION_MODES: readonly PermissionMode[] = [
        'default',
        'read-only',
        'safe-yolo',
        'yolo',
    ];

    const VALID_REMOTE_EFFORTS: readonly ReasoningEffort[] = [
        'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ];

    const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        // Resolve permission mode (validate against Codex-native modes)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const incoming = message.meta.permissionMode as PermissionMode;
            if (VALID_REMOTE_PERMISSION_MODES.includes(incoming)) {
                messagePermissionMode = incoming;
                currentPermissionMode = messagePermissionMode;
                logger.debug('[Codex] Permission mode updated from user message');
            } else {
                logger.debug('[Codex] Ignoring an invalid permission mode from a user message');
            }
        } else {
            logger.debug('[Codex] User message received without a permission-mode override');
        }

        // Resolve model; explicit null resets to default (undefined)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug('[Codex] Model selection updated from user message', {
                hasModel: typeof messageModel === 'string',
            });
        } else {
            logger.debug('[Codex] User message received without a model override');
        }

        // Resolve effort — passed straight to sendTurnAndWait. Validate the
        // incoming value against ReasoningEffort so a stale/garbage entry on
        // the wire doesn't poison the per-turn options.
        let messageEffort = currentEffort;
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[Codex] Effort reset to default`);
            } else if (typeof incoming === 'string' && (VALID_REMOTE_EFFORTS as readonly string[]).includes(incoming)) {
                messageEffort = incoming as ReasoningEffort;
                currentEffort = messageEffort;
                logger.debug('[Codex] Reasoning effort updated from user message');
            } else {
                logger.debug('[Codex] Ignoring an invalid reasoning effort from a user message');
            }
        } else {
            logger.debug('[Codex] User message received without a reasoning-effort override');
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[Codex] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || 'default',
            model: messageModel,
            appendSystemPrompt: messageAppendSystemPrompt,
            effort: messageEffort,
            requestId: message.messageIdentity?.messageId,
        };
        const enqueueResult = enqueueCodexUserText({
            text: message.content.text,
            mode: enhancedMode,
            queue: messageQueue,
            attachments: attachmentsForThisMessage,
        });
        if (enqueueResult === 'clear') {
            logger.debug('[Codex] /clear command pushed to isolated queue');
        }
    }, (error) => {
        logger.warn('[Codex] Failed to handle user message', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    });
    session.onUserMessage(handleUserMessage);
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        session.setActiveRequestId(null);
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch {
            logger.debug('[Codex] Failed to send ready push');
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        logger.debug('[codex][handles] Snapshot captured', {
            handleCount: handles.length,
            requestCount: requests.length,
        });
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController wakes an idle message queue; active-turn cancellation is
    // delivered through the provider protocol's interrupt request.
    let abortController = new AbortController();
    let shouldExit = false;
    const runnerState: { exitReason: CodexExitReason } = { exitReason: 'session-ended' };

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch {
                logger.debug('[Codex] Error during abort');
            } finally {
                resetCurrentModeDefaults();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch {
                logger.debug('[Codex] Error disconnecting Codex during termination');
            }

            // Stop Idle MCP server
            idleServer.stop();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch {
            logger.debug('[Codex] Error during session termination');
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context
    //

    client = new CodexAppServerClient(sandboxConfig);
    client.setUnexpectedExitHandler(() => {
        const handled = handleUnexpectedCodexBackendExit({
            isExitRequested: () => shouldExit,
            requestExit: () => {
                shouldExit = true;
                runnerState.exitReason = 'backend-exit';
            },
            closeQueue: () => messageQueue.close(),
            reportExit: () => {
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Codex backend exited unexpectedly', 'status');
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Codex backend exited unexpectedly',
                });
            },
        });
        if (handled) {
            permissionHandler?.reset('Codex backend exited before responding');
            reasoningProcessor?.abort();
        }
    });

    permissionHandler = new CodexPermissionHandler(session);
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, { currentTurnId });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const updateCodexGoalState = (message: Record<string, unknown>) => {
        const capabilities = codexGoalActionCapabilities(client.supportsGoalActions());
        const goalStatus = mapCodexGoalEventToAgentGoalStatus(
            message,
            client.threadId,
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        session.updateAgentState((currentState) => ({
            ...currentState,
            agentGoalStatus: goalStatus,
        }));
    };
    const handleCodexGoalCommand = async (
        command: CodexGoalCommand,
        threadId: string,
    ): Promise<boolean> => {
        try {
            if (command.type === 'clear') {
                const result = await client.clearGoal({ threadId });
                if (result.cleared !== false) {
                    updateCodexGoalState({
                        type: 'thread_goal_cleared',
                        threadId,
                    });
                }
                messageBuffer.addMessage('Goal cleared', 'status');
                return true;
            }

            const result = await client.setGoal({
                threadId,
                objective: command.objective,
            });
            updateCodexGoalState({
                type: 'thread_goal_updated',
                threadId,
                goal: result.goal,
            });
            messageBuffer.addMessage('Goal updated', 'status');
            return true;
        } catch {
            logger.debug('[Codex] Goal command API failed; falling back to a normal turn');
            return false;
        }
    };
    session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
        const command = parseCodexGoalActionParams(params);
        if (!command) {
            throw new Error('Unsupported Codex goal action');
        }

        const threadId = client.threadId;
        if (!threadId) {
            throw new Error('No active Codex thread');
        }

        const handled = await handleCodexGoalCommand(command, threadId);
        if (!handled) {
            throw new Error('Codex goal actions are not supported by this runtime');
        }

        return { ok: true };
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch {
            logger.debug('[Codex] Error handling permission');
            return 'denied';
        }
    });

    // Event handler: same EventMsg types as the legacy MCP server — no changes needed
    client.setEventHandler((msg) => {
        logger.debug('[Codex] Provider event received');

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }
        if (msg.type === 'thread_goal_updated' || msg.type === 'thread_goal_cleared') {
            updateCodexGoalState(msg);
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
    });

    // Start the authenticated loopback MCP server and prepare its STDIO bridge.
    const idleServer = await startIdleServer(session);
    try {
    const mcpServers = {
        idle: createIdleMcpBridgeConfig(idleServer),
    } as const;
    let first = true;
    let appendSystemPromptInjected = false;

        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        if (opts.resumeThreadId) {
            await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers,
            });
            first = false;
            appendSystemPromptInjected = true;
        }

        const forkCodexThreadId = process.env.IDLE_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId) {
            try {
                const { thread } = await client.readThread({
                    threadId: forkCodexThreadId,
                    includeTurns: true,
                });
                const envelopes = await buildCodexThreadBackfillEnvelopes({
                    thread,
                    uploadLocalImage: (attachment, imageOpts) => (
                        session.uploadLocalImageAttachmentEnvelope(attachment, imageOpts)
                    ),
                });
                for (const envelope of envelopes) {
                    session.sendSessionProtocolMessage(envelope);
                }
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: forkCodexThreadId,
                }));
                logger.debug('[CODEX FORK BACKFILL] Replayed historical envelopes', {
                    envelopeCount: envelopes.length,
                });
            } catch {
                logger.debug('[CODEX FORK BACKFILL] Failed to read source thread');
            }
        }

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            session.setActiveRequestId(message.mode.requestId ?? null);

            if (isCodexClearText(message.message)) {
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                client.clearThreadState();
                currentTurnId = null;
                codexStartedSubagents = new Set<string>();
                codexActiveSubagents = new Set<string>();
                codexProviderSubagentToSessionSubagent = new Map<string, string>();
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                appendSystemPromptInjected = false;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                session.updateMetadata((currentMetadata) => {
                    const nextMetadata = { ...currentMetadata };
                    delete nextMetadata.codexThreadId;
                    return nextMetadata;
                });
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            // Display user messages in the UI
            if (message.message.trim().length > 0) {
                messageBuffer.addMessage(message.message, 'user');
            }

            try {
                // Map permission mode to approval policy and sandbox.
                // With app-server, these are per-turn — no restart needed on mode change.
                const sandboxManagedByIdle = client.sandboxEnabled;
                const executionPolicy = resolveCodexExecutionPolicy(
                    message.mode.permissionMode,
                    sandboxManagedByIdle,
                );

                // Start thread on first turn (thread persists across mode changes)
                let activeThreadId = client.threadId;
                if (!client.hasActiveThread() || !activeThreadId) {
                    const startedThread = await client.startThread({
                        model: message.mode.model,
                        cwd: process.cwd(),
                        approvalPolicy: executionPolicy.approvalPolicy,
                        sandbox: executionPolicy.sandbox,
                        mcpServers,
                    });
                    activeThreadId = startedThread.threadId;
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        codexThreadId: startedThread.threadId,
                    }));
                }

                const goalCommand = parseCodexGoalCommand(message.message);
                if (goalCommand && await handleCodexGoalCommand(goalCommand, activeThreadId)) {
                    continue;
                }

                const includeAppendSystemPrompt = Boolean(
                    message.mode.appendSystemPrompt && !appendSystemPromptInjected,
                );
                const imageInputs = await prepareCodexImageInputItems(message.attachments, {
                    sessionId: session.sessionId,
                });
                if ((message.attachments?.length ?? 0) > 0) {
                    logger.debug('[Codex] Prepared image inputs for turn', {
                        inputCount: imageInputs.inputItems.length,
                        skippedCount: imageInputs.skipped,
                    });
                }
                const hasUserText = message.message.trim().length > 0;
                if ((message.attachments?.length ?? 0) > 0 && imageInputs.inputItems.length === 0 && !hasUserText) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'No supported images were available to send to Codex.',
                    });
                    continue;
                }
                const turnPrompt = buildCodexTurnPrompt({
                    message: message.message,
                    mode: message.mode,
                    includeAppendSystemPrompt,
                    includeTitleInstruction: first,
                });

                const result = await client.sendTurnAndWait(turnPrompt, {
                    model: message.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: message.mode.effort,
                    extraInputItems: imageInputs.inputItems,
                });
                first = false;
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    // Turn was aborted (user abort or permission cancel).
                    // UI handling already done by the event handler (turn_aborted).
                    logger.debug('[Codex] Turn aborted');
                }
            } catch {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in Codex session');
                if (runnerState.exitReason !== 'backend-exit') {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            session.updateMetadata((currentMetadata) => (
                archiveCodexSessionMetadata(currentMetadata, runnerState.exitReason)
            ));
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch {
            logger.debug('[codex]: Error while closing session');
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Idle MCP server
        logger.debug('[codex]: idleServer.stop');
        idleServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
