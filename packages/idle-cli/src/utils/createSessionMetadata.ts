/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for all backends (Claude, Codex, Gemini).
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { SandboxConfig } from '@/persistence';
import packageJson from '../../package.json';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'acp';

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor (claude, codex, gemini) */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
    /**
     * Sandbox config IFF the backend has verified that sandbox enforcement is
     * actually applied to the spawned process (e.g. claudeLocal AFTER a
     * successful `SandboxManager.initialize` + `wrapCommand`). Pass `undefined`
     * for any path that does not wrap the child process with the sandbox
     * runtime — Gemini, Claude SDK/remote, sandbox-init failure, Windows.
     *
     * Idle's mobile UI displays a "(sandboxed)" badge purely on the truthiness
     * of `metadata.sandbox`. Setting this field IS the security claim — only
     * set it only when the claim is true. See docs/permission-resolution.md.
     */
    sandboxEnforced?: SandboxConfig;
    /** Which Codex sandbox boundary was explicitly selected for this session. */
    codexSandboxMode?: 'idle-managed' | 'provider-native';
    /** Whether the backend runs with "dangerously skip permissions" behavior */
    dangerouslySkipPermissions?: boolean;
    /** Idle session id this session was forked from. */
    parentSessionId?: string;
    /** Idle message id used as the fork rewind point. */
    forkedFromMessageId?: string;
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex and Gemini backends, ensuring consistency across all backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'gemini',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: opts.machineId,
        homeDir: os.homedir(),
        idleHomeDir: configuration.idleHomeDir,
        idleLibDir: projectPath(),
        idleToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        sandbox: opts.sandboxEnforced?.enabled ? opts.sandboxEnforced : null,
        ...(opts.codexSandboxMode ? { codexSandboxMode: opts.codexSandboxMode } : {}),
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions ?? null,
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
        ...(opts.forkedFromMessageId ? { forkedFromMessageId: opts.forkedFromMessageId } : {}),
    };

    return { state, metadata };
}
