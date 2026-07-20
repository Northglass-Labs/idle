/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage
} from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    version?: string
    parentUuid?: string | null
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext
    private responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
    private sidechainLastUUID = new Map<string, string>();

    constructor(
        context: Omit<ConversionContext, 'parentUuid'>,
        responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
    ) {
        this.context = {
            ...context,
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
        this.responses = responses
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        let parentUuid = this.lastUuid;
        let isSidechain = false;
        const parentToolUseId = (sdkMessage as any).parent_tool_use_id as string | null | undefined;
        if (parentToolUseId) {
            isSidechain = true;
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null;
            this.sidechainLastUUID.set(parentToolUseId, uuid);
        }
        const baseFields = {
            parentUuid: parentUuid,
            isSidechain: isSidechain,
            userType: 'external' as const,
            sessionId: this.context.sessionId,
            version: this.context.version,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                // The SDK marks context-only injections (e.g. Skill tool
                // feeding the skill body back into the conversation) as
                // `isSynthetic: true` in memory; on disk claude writes the
                // equivalent flag as `isMeta`. The app client and mapper
                // already short-circuit on `isMeta`, so
                // forward the same signal whichever shape we received.
                const meta = (userMsg as any).isSynthetic === true || (userMsg as any).isMeta === true
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message as any,
                    ...(userMsg.parent_tool_use_id ? { parent_tool_use_id: userMsg.parent_tool_use_id } : {}),
                    ...(meta ? { isMeta: true } : {}),
                }

                // Check if this is a tool result and add mode if available
                if (Array.isArray(userMsg.message.content)) {
                    for (const content of userMsg.message.content) {
                        if (content.type === 'tool_result' && content.tool_use_id && this.responses?.has(content.tool_use_id)) {
                            const response = this.responses.get(content.tool_use_id)
                            if (response?.mode) {
                                (logMessage as any).mode = response.mode
                            }
                        }
                    }
                } else if (typeof userMsg.message.content === 'string') {
                    // Simple string content, no tool result
                }
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message as any,
                    ...((assistantMsg as any).isCompactSummary ? { isCompactSummary: true } : {}),
                    ...(assistantMsg.parent_tool_use_id ? { parent_tool_use_id: assistantMsg.parent_tool_use_id } : {}),
                }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage

                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                const tools = Array.isArray(systemMsg.tools)
                    ? systemMsg.tools
                        .filter((tool): tool is string => typeof tool === 'string')
                        .slice(0, 100)
                        .map((tool) => tool.slice(0, 128))
                    : undefined
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    ...(typeof systemMsg.subtype === 'string'
                        ? { subtype: systemMsg.subtype.slice(0, 64) }
                        : {}),
                    ...(typeof systemMsg.model === 'string'
                        ? { model: systemMsg.model.slice(0, 128) }
                        : {}),
                    ...(tools ? { tools } : {}),
                }
                break
            }

            case 'result': {
                // Result messages are not converted to log messages
                // They're SDK-specific messages that indicate session completion
                // Not part of the actual conversation log
                break
            }

            default:
                logMessage = null
        }

        // Update last UUID for parent tracking
        if (logMessage) {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }

    /**
     * Convert a simple string content to a sidechain user message
     * Used for Task tool sub-agent prompts
     */
    convertSidechainUserMessage(toolUseId: string, content: string): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        this.sidechainLastUUID.set(toolUseId, uuid);
        return {
            parentUuid: null,
            isSidechain: true,
            parent_tool_use_id: toolUseId,
            userType: 'external' as const,
            sessionId: this.context.sessionId,
            version: this.context.version,
            type: 'user',
            message: {
                role: 'user',
                content: content
            },
            uuid,
            timestamp
        }
    }

    /**
     * Generate an interrupted tool result message
     * Used when a tool call is interrupted by the user
     * @param toolUseId - The ID of the tool that was interrupted
     * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
     */
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"

        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid

        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }

        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            sessionId: this.context.sessionId,
            version: this.context.version,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any

        // Update last UUID for tracking
        this.lastUuid = uuid

        return logMessage
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage,
    context: Omit<ConversionContext, 'parentUuid'>,
    responses?: Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context, responses)
    return converter.convert(sdkMessage)
}
