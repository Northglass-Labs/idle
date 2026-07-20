/**
 * Claude Code SDK integration for Idle CLI
 * Uses official @anthropic-ai/claude-agent-sdk
 */

export { query } from './query'
export { AbortError } from './types'
export type {
    QueryOptions,
    QueryPrompt,
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    CanCallToolCallback,
    PermissionResult
} from './types'
