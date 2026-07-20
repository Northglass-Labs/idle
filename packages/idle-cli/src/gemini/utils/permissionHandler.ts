/**
 * Gemini Permission Handler
 *
 * Handles tool permission requests and responses for Gemini ACP sessions.
 * Extends BasePermissionHandler with Gemini-specific permission mode logic.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { PermissionMode } from '@/api/types';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

/**
 * Gemini-specific permission handler with permission mode support.
 */
export class GeminiPermissionHandler extends BasePermissionHandler {
    private static readonly ALWAYS_AUTO_APPROVE_NAMES: ReadonlySet<string> = new Set([
        'change_title',
        'idle__change_title',
        'mcp__idle__change_title',
        'GeminiReasoning',
        'CodexReasoning',
        'think',
    ]);

    private static readonly READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
        'Read',
        'Glob',
        'Grep',
        'read_file',
        'read_many_files',
        'list_directory',
        'glob',
        'grep',
        'search_file_content',
    ]);

    private currentPermissionMode: PermissionMode = 'default';

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Gemini]';
    }

    /**
     * Update session reference (override for type visibility)
     */
    updateSession(newSession: ApiSessionClient): void {
        super.updateSession(newSession);
    }

    /**
     * Set the current permission mode
     * This affects how tool calls are automatically approved/denied
     */
    setPermissionMode(mode: PermissionMode): void {
        this.currentPermissionMode = mode;
        logger.debug(`${this.getLogPrefix()} Permission mode updated`);
    }

    /**
     * Check if a tool should be auto-approved based on permission mode
     */
    private shouldAutoApprove(toolName: string): boolean {
        // Always auto-approve these tools regardless of permission mode:
        // - change_title: Changing chat title is safe and should be automatic
        // - GeminiReasoning / CodexReasoning: Display of thinking process, not an action
        // - think: Safe introspective operation
        //
        // Exact-match by tool name (no substring) to prevent bypass through
        // crafted tool names like `change_title_and_run_command`. Include each
        // legitimate naming variant explicitly (bare, MCP-qualified, etc).
        if (GeminiPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.has(toolName)) {
            return true;
        }

        switch (this.currentPermissionMode) {
            case 'yolo':
                // Auto-approve everything in yolo mode
                return true;
            case 'safe-yolo':
            case 'read-only': {
                // Unknown tools are never assumed safe. A denylist lets a new
                // provider tool auto-run merely by choosing an unfamiliar name.
                return GeminiPermissionHandler.READ_ONLY_TOOL_NAMES.has(toolName);
            }
            case 'default':
            default:
                // Default mode - always ask for permission (except for always-auto-approve tools above)
                return false;
        }
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        // Check if we should auto-approve based on permission mode
        if (this.shouldAutoApprove(toolName)) {
            logger.debug(`${this.getLogPrefix()} Auto-approved a tool request`);

            // Update agent state with auto-approved request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        completedAt: Date.now(),
                        status: 'approved',
                        decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
                    }
                }
            }));

            return {
                decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
            };
        }

        // Otherwise, ask for permission
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request queued`);
        });
    }
}
