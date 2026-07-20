/**
 * Type definitions for Claude Code SDK integration
 * Re-exports from official @anthropic-ai/claude-agent-sdk with adapter types
 */

// Re-export message types from official SDK
export type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    PermissionResult,
    CanUseTool,
} from '@anthropic-ai/claude-agent-sdk'

// Re-export AbortError class
export { AbortError } from '@anthropic-ai/claude-agent-sdk'

// Alias for backward compatibility
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
export type CanCallToolCallback = CanUseTool

/**
 * Adapter type for query options.
 * Maps to official SDK's Options type but preserves existing field names
 * used throughout the codebase. The query() wrapper handles the translation.
 */
export interface QueryOptions {
    abort?: AbortSignal
    allowedTools?: string[]
    appendSystemPrompt?: string
    customSystemPrompt?: string
    cwd?: string
    disallowedTools?: string[]
    maxTurns?: number
    mcpServers?: Record<string, unknown>
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    continue?: boolean
    resume?: string
    model?: string
    fallbackModel?: string
    /** Disable local Claude session history for disposable health checks. */
    persistSession?: boolean
    strictMcpConfig?: boolean
    canCallTool?: CanCallToolCallback
    /** Path to a settings JSON file to pass to Claude via --settings */
    settingsPath?: string
    /**
     * Per-session environment variables to apply on top of the SDK's chosen baseline env when
     * spawning Claude Code. Use this for ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, custom proxy
     * config, or anything else session-specific that must NOT leak into the long-lived daemon's
     * process.env.
     *
     * The values land only in the child Claude Code process and disappear when it exits — they
     * do not mutate the parent process.env. Earlier (pre-child-environment isolation) the remote-mode path wrote
     * these to process.env directly, which leaked across concurrent sessions and persisted
     * across the daemon's lifetime.
     */
    additionalEnv?: Record<string, string>
    /**
     * Effort level passed straight through to the Claude Agent SDK option
     * of the same name — controls how much thinking/reasoning Claude
     * applies on each turn ('low' | 'medium' | 'high' | 'xhigh' | 'max').
     * 'xhigh' is supported on the newest Opus generation (e.g. Opus 4.8);
     * the SDK silently downgrades it to 'high' on models without it.
     */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    /** Use the restricted provider-scoped environment instead of all host variables. */
    inheritFullEnvironment?: boolean
    /** Prebuilt synchronous process adapter used after OS sandbox initialization. */
    spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess
}

/**
 * Query prompt types
 */
import type { SDKMessage as _SDKMessage } from '@anthropic-ai/claude-agent-sdk'
export type QueryPrompt = string | AsyncIterable<_SDKMessage>
