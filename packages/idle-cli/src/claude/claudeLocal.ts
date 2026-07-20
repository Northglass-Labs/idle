import { spawn as crossSpawn } from "cross-spawn";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { ensureLocalProxyBypass } from "./utils/proxyBypass";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { getProjectPath } from "./utils/path";
import { projectPath } from "@/projectPath";
import { systemPrompt } from "./utils/systemPrompt";
import type { SandboxConfig } from "@/persistence";
import { initializeSandbox, prepareSandboxedSpawn } from "@/sandbox/manager";
import { buildAgentChildEnvironment } from '@/security/agentChildEnvironment';

/**
 * Error thrown when the Claude process exits with a non-zero exit code.
 */
export class ExitCodeError extends Error {
    public readonly exitCode: number;

    constructor(exitCode: number) {
        super(`Process exited with code: ${exitCode}`);
        this.name = 'ExitCodeError';
        this.exitCode = exitCode;
    }
}


// Get Claude CLI path from project root
export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    mcpServers?: Record<string, any>,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools?: string[],
    /** Path to temporary settings file with SessionStart hook (optional - for session tracking) */
    hookSettingsPath?: string,
    sandboxConfig?: SandboxConfig,
    /**
     * Called when sandbox enforcement is verified to be active (`true`) or
     * known not to be (`false`). The session metadata's `sandbox` field is the
     * mobile UI's security claim — only set it after a successful wrap.
     * Pass `undefined` in paths without an active session (offline reconnect).
     */
    onSandboxApplied?: (applied: boolean) => void,
}) {

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path);
    mkdirSync(projectDir, { recursive: true });

    // Check if claudeArgs contains --continue or --resume (user passed these flags)
    const hasContinueFlag = opts.claudeArgs?.includes('--continue');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume');
    const hasUserSessionControl = hasContinueFlag || hasResumeFlag;

    // Determine if we have an existing session to resume
    // Session ID will always be provided by hook (SessionStart) when Claude starts
    let startFrom = opts.sessionId;

    // Handle session-related flags from claudeArgs to ensure transparent behavior
    // We intercept these flags to use idle-cli's session storage rather than Claude's default
    //
    // Supported patterns:
    // --continue / -c           : Resume last session in current directory
    // --resume / -r             : Resume last session (picker in Claude, but we handle)
    // --resume <id> / -r <id>   : Resume specific session by ID
    // --session-id <uuid>       : Use specific UUID for new session

    // Helper to find and extract flag with optional value
    const extractFlag = (flags: string[], withValue: boolean = false): { found: boolean; value?: string } => {
        if (!opts.claudeArgs) return { found: false };

        for (const flag of flags) {
            const index = opts.claudeArgs.indexOf(flag);
            if (index !== -1) {
                if (withValue && index + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[index + 1];
                    // Check if next arg looks like a value (doesn't start with -)
                    if (!nextArg.startsWith('-')) {
                        const value = nextArg;
                        // Remove both flag and value
                        opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index && i !== index + 1);
                        return { found: true, value };
                    }
                }
                // Don't extract if value was required but not found
                if (!withValue) {
                    opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index);
                    return { found: true };
                }
                return { found: false };
            }
        }
        return { found: false };
    };

    // 1. Check for --session-id <uuid> (explicit new session with specific ID)
    const sessionIdFlag = extractFlag(['--session-id'], true);
    if (sessionIdFlag.found && sessionIdFlag.value) {
        startFrom = null; // Force new session mode, will use this ID below
        logger.debug('[ClaudeLocal] Using an explicit session ID');
    }

    // 2. Check for --resume <id> / -r <id> (resume specific session)
    if (!startFrom && !sessionIdFlag.value) {
        const resumeFlag = extractFlag(['--resume', '-r'], true);
        if (resumeFlag.found) {
            if (resumeFlag.value) {
                startFrom = resumeFlag.value;
                logger.debug('[ClaudeLocal] Using a session ID provided by --resume');
            } else {
                // --resume without value: find last session
                const lastSession = claudeFindLastSession(opts.path);
                if (lastSession) {
                    startFrom = lastSession;
                    logger.debug('[ClaudeLocal] Found the most recent session for --resume');
                }
            }
        }
    }

    // 3. Check for --continue / -c (resume last session)
    if (!startFrom && !sessionIdFlag.value) {
        const continueFlag = extractFlag(['--continue', '-c'], false);
        if (continueFlag.found) {
            const lastSession = claudeFindLastSession(opts.path);
            if (lastSession) {
                startFrom = lastSession;
                logger.debug('[ClaudeLocal] Found the most recent session for --continue');
            }
        }
    }
    // Session ID handling depends on whether we have a hook server
    // - With hookSettingsPath: Session ID comes from Claude via hook (normal mode)
    // - Without hookSettingsPath: We generate session ID ourselves (offline mode)
    const explicitSessionId = sessionIdFlag.value || null;
    let newSessionId: string | null = null;
    let effectiveSessionId: string | null = startFrom;

    if (!opts.hookSettingsPath) {
        // Offline mode: Generate session ID if not resuming
        // Priority: 1. startFrom (resuming), 2. explicit --session-id, 3. generate new UUID
        newSessionId = startFrom ? null : (explicitSessionId || randomUUID());
        effectiveSessionId = startFrom || newSessionId!;

        // Notify about session ID immediately (we know it upfront in offline mode)
        if (startFrom) {
            logger.debug('[ClaudeLocal] Resuming a session');
            opts.onSessionFound(startFrom);
        } else if (explicitSessionId) {
            logger.debug('[ClaudeLocal] Starting with an explicit session ID');
            opts.onSessionFound(explicitSessionId);
        } else {
            logger.debug('[ClaudeLocal] Generated a new session ID');
            opts.onSessionFound(newSessionId!);
        }
    } else {
        // Normal mode with hook server: Session ID comes from Claude via hook
        if (startFrom) {
            logger.debug('[ClaudeLocal] Will resume an existing session');
        } else if (hasUserSessionControl) {
            logger.debug(`[ClaudeLocal] User passed ${hasContinueFlag ? '--continue' : '--resume'} flag, session ID will be determined by hook`);
        } else {
            logger.debug(`[ClaudeLocal] Fresh start, session ID will be provided by hook`);
        }
    }

    // Thinking state
    let thinking = false;
    let stopThinkingTimeout: NodeJS.Timeout | null = null;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Spawn the process
    try {
        // Start the interactive process
        process.stdin.pause();

        // The interactive child inherits stdin and requires blocking reads.
        // Clear O_NONBLOCK before the descriptor is duplicated into the child
        // so terminal input cannot surface transient EAGAIN failures.
        const stdinHandle = (process.stdin as any)._handle;
        if (stdinHandle && typeof stdinHandle.setBlocking === 'function') {
            try {
                stdinHandle.setBlocking(true);
                logger.debug('[ClaudeLocal] forced stdin to blocking mode before spawn');
            } catch {
                logger.debug('[ClaudeLocal] Failed to set blocking stdin mode');
            }
        }

        await new Promise<void>((r, reject) => {
            const args: string[] = []

            // Session/resume args depend on whether we're in offline mode or hook mode
            if (!opts.hookSettingsPath) {
                // Offline mode: We control session ID
                const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
                if (startFrom) {
                    // Resume existing session (Claude preserves the session ID)
                    args.push('--resume', startFrom)
                } else if (!hasResumeFlag && newSessionId) {
                    // New session with our generated UUID
                    args.push('--session-id', newSessionId)
                }
            } else {
                // Hook mode restores the canonical resume flag only when the
                // caller supplies a resolved session identifier.
                if (startFrom) {
                    args.push('--resume', startFrom);
                }
            }
            // If hasResumeFlag && !startFrom: --resume is in claudeArgs, let Claude handle it

            args.push('--append-system-prompt', systemPrompt);

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
            }

            if (opts.allowedTools && opts.allowedTools.length > 0) {
                args.push('--allowedTools', opts.allowedTools.join(','));
            }

            // Add custom Claude arguments
            if (opts.claudeArgs) {
                args.push(...opts.claudeArgs)
            }

            // Add hook settings for session tracking (when available)
            if (opts.hookSettingsPath) {
                args.push('--settings', opts.hookSettingsPath);
                logger.debug('[ClaudeLocal] Using generated hook settings');
            }

            if (!claudeCliPath || !existsSync(claudeCliPath)) {
                throw new Error('Claude local launcher not found. Please ensure IDLE_PROJECT_ROOT is set correctly for development.');
            }

            // Prepare environment variables
            // Note: Local mode uses global Claude installation with --session-id flag
            // Launcher only intercepts fetch for thinking state tracking
            const env = opts.sandboxConfig?.enabled
                ? buildAgentChildEnvironment('claude', process.env, opts.claudeEnvVars)
                : { ...process.env, ...opts.claudeEnvVars };

            if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
                ensureLocalProxyBypass(env);
            }

            logger.debug(`[ClaudeLocal] Spawning launcher (argumentCount=${args.length})`);

            (async () => {
                let cleanupSandbox: (() => Promise<void>) | null = null;
                let spawnCommand = 'node';
                let spawnArgs: string[] = [claudeCliPath, ...args];

                if (opts.sandboxConfig?.enabled) {
                    if (process.platform === 'win32') {
                        opts.onSandboxApplied?.(false);
                        throw new Error(
                            'Claude sandboxing is not supported on Windows. Disable the configured sandbox explicitly to continue without it.',
                        );
                    } else {
                        try {
                            cleanupSandbox = await initializeSandbox(opts.sandboxConfig, opts.path);
                            const wrapSpawn = await prepareSandboxedSpawn();
                            const wrapped = wrapSpawn('node', spawnArgs);
                            spawnCommand = wrapped.command;
                            spawnArgs = wrapped.args;

                            logger.info('[ClaudeLocal] Sandbox enabled', {
                                networkMode: opts.sandboxConfig.networkMode,
                            });
                            // Tell the caller it's safe to claim sandbox in metadata.
                            opts.onSandboxApplied?.(true);
                        } catch (error) {
                            opts.onSandboxApplied?.(false);
                            if (cleanupSandbox) {
                                try { await cleanupSandbox(); } catch { /* preserve the initialization error */ }
                                cleanupSandbox = null;
                            }
                            logger.warn('[ClaudeLocal] Failed to initialize the required sandbox.');
                            const reason = error instanceof Error ? error.message : String(error);
                            throw new Error(`Claude sandbox initialization failed: ${reason}`, { cause: error });
                        }
                    }
                } else {
                    // No sandbox requested — be explicit so the caller can ensure
                    // metadata is null (in case a prior local-mode run set it).
                    opts.onSandboxApplied?.(false);
                }

                // Use cross-spawn so `node` resolves to `node.exe` on Windows.
                let child;
                try {
                    child = crossSpawn(
                        spawnCommand,
                        spawnArgs,
                        {
                            stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
                            signal: opts.abort,
                            cwd: opts.path,
                            env,
                            shell: false,
                            windowsHide: true,
                        },
                    );
                } catch (error) {
                    try {
                        await cleanupSandbox?.();
                    } finally {
                        if (cleanupSandbox) {
                            opts.onSandboxApplied?.(false);
                        }
                    }
                    throw error;
                }

                // Listen to the custom fd (fd 3) for thinking state tracking
                if (child.stdio[3]) {
                    const rl = createInterface({
                        input: child.stdio[3] as any,
                        crlfDelay: Infinity
                    });

                    // Track active fetches for thinking state
                    const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

                    rl.on('line', (line) => {
                        try {
                            const message = JSON.parse(line);

                            switch (message.type) {
                                case 'fetch-start':
                                    activeFetches.set(message.id, {
                                        hostname: message.hostname,
                                        path: message.path,
                                        startTime: message.timestamp
                                    });

                                    // Clear any pending stop timeout
                                    if (stopThinkingTimeout) {
                                        clearTimeout(stopThinkingTimeout);
                                        stopThinkingTimeout = null;
                                    }

                                    // Start thinking
                                    updateThinking(true);
                                    break;

                                case 'fetch-end':
                                    activeFetches.delete(message.id);

                                    // Stop thinking when no active fetches
                                    if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                                        stopThinkingTimeout = setTimeout(() => {
                                            if (activeFetches.size === 0) {
                                                updateThinking(false);
                                            }
                                            stopThinkingTimeout = null;
                                        }, 500); // Small delay to avoid flickering
                                    }
                                    break;

                                default:
                                    logger.debug('[ClaudeLocal] Ignored an unknown launcher event');
                            }
                        } catch {
                            // Not JSON, ignore (could be other output)
                            logger.debug('[ClaudeLocal] Ignored non-JSON launcher output', {
                                bytes: Buffer.byteLength(line, 'utf8'),
                            });
                        }
                    });

                    rl.on('error', () => {
                        logger.debug('[ClaudeLocal] Launcher event stream failed');
                    });

                    // Cleanup on child exit
                    child.on('exit', () => {
                        if (stopThinkingTimeout) {
                            clearTimeout(stopThinkingTimeout);
                        }
                        updateThinking(false);
                    });
                }
                child.on('error', () => {
                    // Ignore
                });
                child.on('exit', async (code, signal) => {
                    if (cleanupSandbox) {
                        try {
                            await cleanupSandbox();
                        } catch {
                            logger.warn('[ClaudeLocal] Failed to reset sandbox after session exit.');
                        } finally {
                            opts.onSandboxApplied?.(false);
                        }
                    }

                    if (signal === 'SIGTERM' && opts.abort.aborted) {
                        // Normal termination due to abort signal
                        r();
                    } else if (signal) {
                        reject(new Error(`Process terminated with signal: ${signal}`));
                    } else if (code !== 0 && code !== null) {
                        // Non-zero exit code - propagate it
                        reject(new ExitCodeError(code));
                    } else {
                        r();
                    }
                });
            })().catch(reject);
        });
    } finally {
        process.stdin.resume();
        if (stopThinkingTimeout) {
            clearTimeout(stopThinkingTimeout);
            stopThinkingTimeout = null;
        }
        updateThinking(false);
    }

    // Return the effective session ID (what was actually used)
    // - In offline mode: Our generated or resumed session ID
    // - In hook mode: The session ID from startFrom (if resuming) or null (new session - hook will report ID)
    return effectiveSessionId;
}
