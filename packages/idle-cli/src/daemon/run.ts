import fs from 'fs/promises';
import os from 'os';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from './spawnSessionOptions';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { spawnIdleCLI } from '@/utils/spawnIdleCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession, readSettings } from '@/persistence';
import type { PersistedSession } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledIdleVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { detectCLIAvailability, buildAugmentedPath } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localIdleAgentAuth';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import { decryptSessionField } from '@/api/sessionFieldEncryption';
import { randomBytes } from 'node:crypto';
import { terminateTrackedSession } from './terminateTrackedSession';
import {
  hasExplicitCodexSandboxCredential,
  hasKeyringBackedChatGptLogin,
} from '@/codex/codexAppServerClient';
import { resolveCodexRuntimeSourceHome } from '@/codex/isolatedRuntimeHome';
import { resolveCodexSpawnSandboxPolicy } from '@/codex/codexSpawnSandboxPolicy';

/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

type DirectoryCreationFailureKind = 'permission-denied' | 'invalid-parent' | 'disk-full' | 'read-only' | 'system';

function describeDirectoryCreationFailure(error: unknown): {
  kind: DirectoryCreationFailureKind;
  message: string;
} {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;

  switch (code) {
    case 'EACCES':
      return {
        kind: 'permission-denied',
        message: 'Unable to create the requested directory: permission denied. Choose a different location or update its permissions.',
      };
    case 'ENOTDIR':
      return {
        kind: 'invalid-parent',
        message: 'Unable to create the requested directory because part of the location is not a directory. Choose a different location.',
      };
    case 'ENOSPC':
      return {
        kind: 'disk-full',
        message: 'Unable to create the requested directory because the disk is full. Free some space and try again.',
      };
    case 'EROFS':
      return {
        kind: 'read-only',
        message: 'Unable to create the requested directory because the file system is read-only. Choose a writable location.',
      };
    default:
      return {
        kind: 'system',
        message: 'Unable to create the requested directory because the system rejected it. Verify the location and try again.',
      };
  }
}

// Prepare initial metadata
// Suffix host with `-dev` for the IDLE_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.IDLE_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  idleCliVersion: packageJson.version,
  homeDir: os.homedir(),
  idleHomeDir: configuration.idleHomeDir,
  idleLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
};

export async function startDaemon(): Promise<void> {
  // A detached background daemon can inherit a reduced PATH that omits
  // user-local bin dirs — notably ~/.local/bin, where Claude Code's native
  // installer puts `claude`. Augment it once here so CLI detection, the
  // Claude SDK's executable lookup, and spawned agent processes all resolve
  // binaries the way an interactive shell would.
  process.env.PATH = buildAugmentedPath(os.homedir(), process.env.PATH);

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'idle-app' | 'idle-cli' | 'os-signal' | 'exception') => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'idle-app' | 'idle-cli' | 'os-signal' | 'exception' })>((resolve) => {
    requestShutdown = (source) => {
      logger.debug('[DAEMON RUN] Shutdown requested');

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', () => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception');
    requestShutdown('exception');
  });

  process.on('unhandledRejection', () => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection');
    requestShutdown('exception');
  });

  process.on('exit', () => {
    logger.debug('[DAEMON RUN] Process exiting');
  });

  process.on('beforeExit', () => {
    logger.debug('[DAEMON RUN] Process preparing to exit');
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debug('[DAEMON RUN] Environment observed', {
    variableCount: Object.keys(process.env).length,
    debugEnabled: Boolean(process.env.DEBUG),
  });

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledIdleVersion();
  if (!runningDaemonVersionMatches) {
    // A mismatched process must release the authenticated control plane before
    // this invocation acquires the single-daemon lock.
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    for (const [id, s] of Object.entries(persisted)) {
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        idleSessionId: id,
        idleSessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from idle session reporting itself
    const onIdleSessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debug('[DAEMON RUN] Session report received', {
        metadataFieldCount: Object.keys(sessionMetadata).length,
        hasHostPid: Boolean(sessionMetadata.hostPid),
        hasEncryption: Boolean(encryption),
      });

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug('[DAEMON RUN] Session report rejected because hostPid is missing');
        return;
      }

      logger.debug('[DAEMON RUN] Processing session report', {
        hasEncryption: Boolean(encryption),
        wasStartedByDaemon: sessionMetadata.startedBy === 'daemon',
        trackedSessionCount: pidToTrackedSession.size,
      });

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
        });
      }

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.idleSessionId = sessionId;
        existingSession.idleSessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.encryption = encryption;
        logger.debug('[DAEMON RUN] Updated daemon-spawned session metadata');

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug('[DAEMON RUN] Resolved session startup waiter');
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'idle directly - likely by user from terminal',
          idleSessionId: sessionId,
          idleSessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug('[DAEMON RUN] Registered externally-started session');
      }
    };

    // Spawn a new Idle session; provider conversation resume IDs are handled
    // explicitly at the provider command boundary below.
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debug('[DAEMON RUN] Session spawn requested', {
        hasExplicitAgent: options.agent !== undefined,
        hasExistingSession: Boolean(options.sessionId),
        hasEnvironmentOverrides: Boolean(options.environmentVariables && Object.keys(options.environmentVariables).length > 0),
      });

      const persistedSettings = await readSettings();
      const codexSandboxPolicy = resolveCodexSpawnSandboxPolicy({
        agent: options.agent,
        idleSandboxEnabled: persistedSettings?.sandboxConfig?.enabled === true,
        providerNativeSandboxApproved: options.codexProviderNativeSandboxApproved === true,
        hasExplicitSandboxCredential: hasExplicitCodexSandboxCredential(process.env),
        hasKeyringChatGptLogin: options.agent === 'codex'
          ? hasKeyringBackedChatGptLogin(resolveCodexRuntimeSourceHome())
          : false,
      });
      if (codexSandboxPolicy === 'provider-native-approval-required') {
        logger.debug('[DAEMON RUN] Codex native sandbox approval required');
        return { type: 'requestToApproveCodexNativeSandbox' };
      }
      const useCodexProviderNativeSandbox = codexSandboxPolicy === 'provider-native';

      const { directory, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug('[DAEMON RUN] Requested directory exists');
      } catch {
        logger.debug('[DAEMON RUN] Requested directory does not exist');

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug('[DAEMON RUN] Directory creation requires approval');
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug('[DAEMON RUN] Requested directory created');
          directoryCreated = true;
        } catch (mkdirError) {
          const failure = describeDirectoryCreationFailure(mkdirError);
          logger.debug('[DAEMON RUN] Directory creation failed', { failureKind: failure.kind });
          return {
            type: 'error',
            errorMessage: failure.message,
          };
        }
      }

      try {

        let extraEnv: Record<string, string> = {
          ...(options.environmentVariables ?? {}),
        };
        // Carry the in-app Co-Authored-By preference into the spawned session.
        // The CLI's shouldIncludeCoAuthoredBy() reads this.
        if (options.commitAttribution !== undefined) {
          extraEnv.IDLE_COMMIT_ATTRIBUTION = options.commitAttribution ? '1' : '0';
        }
        if (options.parentSessionId) {
          extraEnv.IDLE_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.IDLE_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        // For fork: spawned Idle CLI needs to know which Claude JSONL to
        // backfill into the fresh Idle session row. Without this, the
        // SDK reads the JSONL silently as context but never re-emits the
        // historical messages, so the app shows an empty chat.
        if (options.resumeClaudeSessionId) {
          extraEnv.IDLE_FORK_CLAUDE_SESSION_ID = options.resumeClaudeSessionId;
        }
        if (options.resumeCodexThreadId) {
          extraEnv.IDLE_FORK_CODEX_THREAD_ID = options.resumeCodexThreadId;
        }
        logger.debug('[DAEMON RUN] Session environment prepared', {
          variableCount: Object.keys(extraEnv).length,
        });

        // Resolve configured environment references before either launch path.
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug('[DAEMON RUN] Session environment expansion completed', {
          variableCount: Object.keys(extraEnv).length,
        });

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          logger.warn('[DAEMON RUN] Session environment contains unavailable references', {
            unavailableReferenceCount: unresolvedEnvEntries.length,
          });
          return {
            type: 'error',
            errorMessage: 'Session environment is invalid because one or more referenced variables are unavailable. Configure the daemon environment and try again.',
          };
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          logger.debug('[DAEMON RUN] Attempting to spawn session in tmux', {
            usesNamedSession: tmuxSessionName.length > 0,
          });

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : (options.agent === 'openclaw' ? 'openclaw' : 'claude'));
          const resumeId = agent === 'claude'
            ? options.resumeClaudeSessionId
            : (agent === 'codex' ? options.resumeCodexThreadId : undefined);
          const resumeFragment = resumeId
            ? ` --resume ${shellescape(resumeId)}`
            : '';
          const codexSandboxFragment = agent === 'codex' && useCodexProviderNativeSandbox
            ? ' --no-sandbox'
            : '';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent}${codexSandboxFragment} --idle-starting-mode remote --started-by daemon${resumeFragment}`;

          // Spawn in tmux with environment variables
          // tmux needs explicit values because it does not inherit the same
          // environment merge used by the direct spawn path.
          const windowName = `idle-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug('[DAEMON RUN] Successfully spawned process in tmux');

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with idleSessionId (exact same as regular flow)
            logger.debug('[DAEMON RUN] Waiting for tmux session report');

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug('[DAEMON RUN] Timed out waiting for tmux session report');
                resolve({
                  type: 'error',
                  errorMessage: 'Timed out waiting for the spawned session to report readiness.',
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug('[DAEMON RUN] Tmux session reported readiness');
                resolve({
                  type: 'success',
                  sessionId: completedSession.idleSessionId!
                });
              });
            });
          } else {
            logger.debug('[DAEMON RUN] Tmux spawn failed; falling back to regular process spawning');
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            case 'openclaw':
              agentCommand = 'openclaw';
              break;
            default:
              return {
                type: 'error',
                errorMessage: 'Unsupported agent type. Please update your CLI to the latest version.',
              };
          }
          const args = [
            agentCommand,
            '--idle-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          if (agentCommand === 'codex' && useCodexProviderNativeSandbox) {
            args.splice(1, 0, '--no-sandbox');
          }

          // Resume ids attach the new Idle session to a pre-existing provider
          // conversation created by the fork / duplicate RPC.
          if (options.resumeClaudeSessionId && agentCommand === 'claude') {
            args.push('--resume', options.resumeClaudeSessionId);
          }
          if (options.resumeCodexThreadId && agentCommand === 'codex') {
            args.push('--resume', options.resumeCodexThreadId);
          }

          // The Idle sessionId identifies the control-plane request; only the
          // provider-specific resume fields reattach an existing conversation.
          return spawnTrackedIdleProcess({
            args,
            cwd: directory,
            env: {
              ...process.env,
              ...extraEnv
            },
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch {
        logger.debug('[DAEMON RUN] Failed to spawn session');
        return {
          type: 'error',
          errorMessage: 'Failed to spawn session.',
        };
      }
    };

    const spawnTrackedIdleProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
    }): Promise<SpawnSessionResult> => {
      const idleProcess = spawnIdleCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!idleProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Idle process - no PID returned'
        });
      }

      logger.debug('[DAEMON RUN] Spawned Idle process');

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: idleProcess.pid,
        childProcess: idleProcess,
        directoryCreated,
        message,
      };

      pidToTrackedSession.set(idleProcess.pid, trackedSession);

      idleProcess.on('exit', (code, signal) => {
        logger.debug('[DAEMON RUN] Child process exited', {
          hasExitCode: code !== null,
          wasSignaled: signal !== null,
        });
        if (idleProcess.pid) {
          onChildExited(idleProcess.pid);
        }
      });

      idleProcess.on('error', () => {
        logger.debug('[DAEMON RUN] Child process reported an error');
        if (idleProcess.pid) {
          onChildExited(idleProcess.pid);
        }
      });

      logger.debug('[DAEMON RUN] Waiting for spawned session report');

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(idleProcess.pid!);
          logger.debug('[DAEMON RUN] Timed out waiting for spawned session report');
          resolve({
            type: 'error',
            errorMessage: 'Timed out waiting for the spawned session to report readiness.',
          });
        }, 15_000);

        pidToAwaiter.set(idleProcess.pid!, (completedSession) => {
          clearTimeout(timeout);
          logger.debug('[DAEMON RUN] Spawned session reported readiness');
          resolve({
            type: 'success',
            sessionId: completedSession.idleSessionId!
          });
        });
      });
    };

    const findTrackedSessionById = (idleSessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.idleSessionId === idleSessionId) return session;
      }
      return sessionIdToFinishedSession.get(idleSessionId);
    };

    const fetchServerSessionMetadata = async (sessionId: string, encryptionKey: Uint8Array, encryptionVariant: 'legacy' | 'dataKey'): Promise<Metadata | null> => {
      try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
          timeout: 10_000,
          maxRedirects: 0,
        });
        const sessions = (response.data as {
          sessions: { id: string; metadata: string; metadataVersion: number }[];
        }).sessions;
        const matched = sessions.find(s => s.id === sessionId);
        if (!matched) return null;
        const decrypted = decryptSessionField<Metadata>(
          { key: encryptionKey, variant: encryptionVariant },
          matched.id,
          'metadata',
          matched.metadataVersion,
          matched.metadata,
          { allowLegacy: true },
        );
        return decrypted.success ? decrypted.value : null;
      } catch {
        logger.debug('[DAEMON RUN] Failed to fetch session metadata from server');
        return null;
      }
    };

    const resumeSession = async (idleSessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      try {
        const tracked = findTrackedSessionById(idleSessionId);
        if (!tracked) {
          return { type: 'error', errorMessage: 'The requested session is not tracked by this daemon. It may have been started before the daemon or on another machine.' };
        }
        if (!tracked.idleSessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: 'The requested session has no available metadata and cannot be resumed.' };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: 'The requested session has no stored encryption data. Restart the daemon and start a new session to enable resume.' };
        }

        // Webhook metadata may be stale (missing claudeSessionId/codexThreadId set after startup).
        // Fetch fresh metadata from server if needed.
        let metadata = tracked.idleSessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
          || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
          logger.debug('[DAEMON RUN] Session metadata is missing a provider identifier; fetching current metadata');
          const serverMetadata = await fetchServerSessionMetadata(idleSessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
          if (serverMetadata) {
            metadata = serverMetadata;
            tracked.idleSessionMetadataFromLocalWebhook = serverMetadata;
          }
        }

        const launch = buildResumeLaunch(
          { id: idleSessionId, active: true, metadata },
          { startedBy: 'daemon', claudeStartingMode: 'remote' },
        );

        if (options?.model) {
          launch.args.push('--model', options.model);
        }
        if (options?.permissionMode) {
          launch.args.push('--permission-mode', options.permissionMode);
        }

        await fs.access(launch.cwd);

        return spawnTrackedIdleProcess({
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...process.env,
            IDLE_RECONNECT_SESSION_ID: idleSessionId,
            IDLE_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            IDLE_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            IDLE_RECONNECT_SEQ: String(tracked.encryption.seq),
            IDLE_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            IDLE_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
          },
        });
      } catch {
        logger.debug('[DAEMON RUN] Failed to resume session');
        return {
          type: 'error',
          errorMessage: 'Failed to resume session.',
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (sessionId: string): Promise<boolean> => {
      logger.debug('[DAEMON RUN] Attempting to stop a tracked session');

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.idleSessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          const stopped = await terminateTrackedSession(session);
          if (!stopped) {
            logger.debug('[DAEMON RUN] Failed to confirm tracked-session termination');
            return false;
          }

          pidToTrackedSession.delete(pid);
          logger.debug('[DAEMON RUN] Confirmed termination and removed session from tracking');
          return true;
        }
      }

      logger.debug('[DAEMON RUN] Requested session was not found');
      return false;
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.idleSessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.idleSessionId, session);
        logger.debug('[DAEMON RUN] Exited session retained for resume');
      } else {
        logger.debug('[DAEMON RUN] Removing exited process from tracking');
      }
      pidToTrackedSession.delete(pid);
    };

    // Start control server
    const controlToken = randomBytes(32).toString('base64url');
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      authToken: controlToken,
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('idle-cli'),
      onIdleSessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      controlToken,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Capture the bundled CLI's mtime at startup. The built artifact is the
    // authoritative upgrade signal because an on-disk manifest can diverge
    // from the executing bundle and cause a restart loop.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug('[DAEMON RUN] Bundle not found; self-restart on upgrade disabled');
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug('[DAEMON RUN] Machine registered');

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      stopSession,
      requestShutdown: () => requestShutdown('idle-app')
    });

    // Connect to server
    apiMachine.connect();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.IDLE_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug('[DAEMON RUN] Health check started');
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch {
          // Process is dead, remove from tracking
          logger.debug('[DAEMON RUN] Removing stale session because its process no longer exists');
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced) {
        // Hand off only after an installed bundle replacement is observed;
        // state ownership is released before the replacement process starts.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `idle daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningCurrentlyInstalledIdleVersion() === true, and exits —
        // leaving nothing running once we also exit.
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnIdleCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch {
          logger.debug('[DAEMON RUN] Failed to spawn replacement daemon');
        }

        process.exit(0);
      }

      // Stop if another process has replaced this daemon's persisted state.
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Daemon ownership changed; stopping this process')
        requestShutdown('exception')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          controlToken: fileState.controlToken,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug('[DAEMON RUN] Health check completed');
        }
      } catch {
        logger.debug('[DAEMON RUN] Failed to write heartbeat');
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'idle-app' | 'idle-cli' | 'os-signal' | 'exception') => {
      logger.debug('[DAEMON RUN] Starting cleanup');

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source);
  } catch {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1');
    process.exit(1);
  }
}
