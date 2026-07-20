/**
 * Message Reducer for Real-time Sync System
 *
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 *
 * ## Core Responsibilities:
 *
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 *
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled)
 *    - Matches incoming tool calls to approved permissions
 *    - Prioritizes tool calls over permissions when both exist
 *
 * 3. **Tool Call Lifecycle**: Manages the complete lifecycle of tool calls:
 *    - Creation from permission requests or direct tool calls
 *    - Matching tool calls to existing permission messages
 *    - Processing tool results and updating states
 *    - Handling errors and completion states
 *
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Identifies sidechain messages using the tracer
 *    - Stores sidechain messages separately
 *    - Links sidechains to their parent tool calls
 *
 * ## Processing Phases:
 *
 * The reducer processes messages in a specific order to ensure correct behavior:
 *
 * **Phase 0: AgentState Permissions**
 *   - Processes pending and completed permission requests
 *   - Creates tool messages for permissions
 *   - Skips completed permissions if matching tool call (same name AND arguments) exists in incoming messages
 *   - Phase 2 will handle matching tool calls to existing permission messages
 *
 * **Phase 0.5: Message-to-Event Conversion**
 *   - Parses messages to check if they should be converted to events
 *   - Converts matching messages to events immediately
 *   - Converted messages skip all subsequent processing phases
 *   - Supports user commands, tool results, and metadata-driven conversions
 *
 * **Phase 1: User and Text Messages**
 *   - Processes user messages with deduplication
 *   - Processes agent text messages
 *   - Skips tool calls for later phases
 *
 * **Phase 2: Tool Calls**
 *   - Processes incoming tool calls from agents
 *   - Matches to existing permission messages when possible
 *   - Creates new tool messages when no match exists
 *   - Prioritizes newest permission when multiple matches
 *
 * **Phase 3: Tool Results**
 *   - Updates tool messages with results
 *   - Sets completion or error states
 *   - Updates completion timestamps
 *
 * **Phase 4: Sidechains**
 *   - Processes sidechain messages separately
 *   - Stores in sidechain map linked to parent tool
 *   - Handles nested tool calls within sidechains
 *
 * **Phase 5: Mode Switch Events**
 *   - Processes agent event messages
 *   - Handles mode changes and other events
 *
 * ## Key Behaviors:
 *
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Argument Matching**: Tool calls match to permissions based on both name AND arguments
 * - **Timestamp Preservation**: Original timestamps are preserved when matching tools to permissions
 * - **State Persistence**: The ReducerState maintains all mappings across calls
 * - **Message Immutability**: NEVER modify message timestamps or core properties after creation
 *   Messages can only have their tool state/result updated, never their creation metadata
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp. The timestamp
 *   represents when the message was originally created and must be preserved throughout all
 *   processing phases. This is critical for maintaining correct message ordering.
 *
 * ## Permission Matching Algorithm:
 *
 * When a tool call arrives, the matching algorithm:
 * 1. Checks if the tool has already been processed (via toolIdToMessageId)
 * 2. Searches for approved permission messages with:
 *    - Same tool name
 *    - Matching arguments (deep equality)
 *    - Not already linked to another tool
 * 3. Prioritizes the newest matching permission
 * 4. Updates the permission message with tool execution details
 * 5. Falls back to creating a new tool message if no match
 *
 * ## Data Flow:
 *
 * Raw Messages → Normalizer → Reducer → Structured Messages
 *                              ↑
 *                         AgentState
 *
 * The reducer receives:
 * - Normalized messages from the sync system
 * - Current AgentState with permission information
 *
 * And produces:
 * - Structured Message objects for UI rendering
 * - Updated internal state for future processing
 */

import { Message, ToolCall } from "../typesMessage";
import { AgentEvent, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState, TodoItem, TodoItemsSchema } from "../storageTypes";
import { MessageMeta } from "../typesMessageMeta";
import { parseMessageAsEvent } from "./messageToEvent";
import {
    estimateApproximateBytes,
    MAX_RETAINED_SESSION_MESSAGE_BYTES,
    MAX_STORED_SESSION_MESSAGES,
} from "../sessionMessageLimits";

type ReducerMessage = {
    id: string;
    localId?: string | null;
    realID: string | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
    claudeUuid?: string;
    codexItemId?: string;
}

type StoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

export type ReducerState = {
    toolIdToMessageId: Map<string, string>; // toolId/permissionId -> messageId (since they're the same now)
    sidechainToolIdToMessageId: Map<string, string>; // toolId -> sidechain messageId (for dual tracking)
    permissions: Map<string, StoredPermission>; // Store permission details by ID for quick lookup
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>;
    tracerState: TracerState; // Tracer state for sidechain processing
    latestTodos?: {
        todos: TodoItem[];
        timestamp: number;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    };
};

export function createReducer(): ReducerState {
    return {
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        permissions: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer()
    }
};

function trimMapToLimit<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) {
        const oldestKey = map.keys().next().value as K | undefined;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

function retainRequiredAndRecentMapEntries<K, V>(
    map: Map<K, V>,
    isRequired: (key: K, value: V) => boolean,
    limit: number,
): void {
    if (map.size <= limit) return;
    const entries = [...map.entries()];
    const required = entries.filter(([key, value]) => isRequired(key, value)).slice(-limit);
    const requiredKeys = new Set(required.map(([key]) => key));
    const optionalCapacity = limit - required.length;
    const optional = optionalCapacity > 0
        ? entries.filter(([key]) => !requiredKeys.has(key)).slice(-optionalCapacity)
        : [];
    map.clear();
    for (const [key, value] of [...optional, ...required]) map.set(key, value);
}

function compareNewestFirst(left: ReducerMessage, right: ReducerMessage): number {
    return right.createdAt - left.createdAt;
}

function collectMessageTreeIds(messages: readonly Message[], ids: Set<string>): void {
    for (const message of messages) {
        if (ids.has(message.id)) continue;
        ids.add(message.id);
        if (message.kind === 'tool-call') {
            collectMessageTreeIds(message.children, ids);
        }
    }
}

const REDUCER_INDEX_RESERVE_BYTES = 1024 * 1024;
const REDUCER_MESSAGE_LINK_OVERHEAD_BYTES = 256;

function estimateReducerMessageBytes(message: ReducerMessage, byteLimit: number): number {
    const estimated = estimateApproximateBytes(message, byteLimit);
    if (estimated > byteLimit || estimated + REDUCER_MESSAGE_LINK_OVERHEAD_BYTES > byteLimit) {
        return byteLimit + 1;
    }
    return estimated + REDUCER_MESSAGE_LINK_OVERHEAD_BYTES;
}

function selectRecentReducerMessageIds(
    state: ReducerState,
    limit: number,
    byteLimit: number,
): Set<string> {
    const sidechainChildIds = new Set<string>();
    for (const children of state.sidechains.values()) {
        for (const child of children) sidechainChildIds.add(child.id);
    }

    const rootCandidates = [...state.messages.values()]
        .filter((message) => !sidechainChildIds.has(message.id))
        .sort(compareNewestFirst);
    const roots: ReducerMessage[] = [];
    let remainingBytes = Math.max(0, byteLimit - REDUCER_INDEX_RESERVE_BYTES);
    for (const root of rootCandidates) {
        if (roots.length >= limit || remainingBytes <= 0) break;
        const rootBytes = estimateReducerMessageBytes(root, remainingBytes);
        if (rootBytes > remainingBytes) continue;
        roots.push(root);
        remainingBytes -= rootBytes;
    }

    const retainedIds = new Set(roots.map((message) => message.id));
    const expandedOwnerIds = new Set<string>();
    let remaining = limit - retainedIds.size;

    const retainChildren = (owner: ReducerMessage): void => {
        if (remaining <= 0 || !owner.realID || expandedOwnerIds.has(owner.id)) return;
        expandedOwnerIds.add(owner.id);
        const children = [...(state.sidechains.get(owner.realID) ?? [])]
            .sort(compareNewestFirst);
        for (const child of children) {
            if (remaining <= 0 || remainingBytes <= 0) break;
            if (!retainedIds.has(child.id)) {
                const childBytes = estimateReducerMessageBytes(child, remainingBytes);
                if (childBytes > remainingBytes) continue;
                retainedIds.add(child.id);
                remaining -= 1;
                remainingBytes -= childBytes;
            }
        }
        for (const child of children) {
            if (remaining <= 0) break;
            if (retainedIds.has(child.id)) retainChildren(child);
        }
    };

    for (const root of roots) {
        if (remaining <= 0) break;
        retainChildren(root);
    }

    return retainedIds;
}

function boundOrphanMessages(state: TracerState, limit: number): Set<string> {
    const retained: { parentUuid: string; message: NormalizedMessage }[] = [];
    for (const [parentUuid, messages] of state.orphanMessages) {
        for (const message of messages) {
            if (retained.length < limit) {
                retained.push({ parentUuid, message });
                continue;
            }
            let oldestIndex = 0;
            for (let index = 1; index < retained.length; index += 1) {
                if (retained[index].message.createdAt < retained[oldestIndex].message.createdAt) {
                    oldestIndex = index;
                }
            }
            if (message.createdAt > retained[oldestIndex].message.createdAt) {
                retained[oldestIndex] = { parentUuid, message };
            }
        }
    }
    retained.sort((left, right) => left.message.createdAt - right.message.createdAt);

    state.orphanMessages.clear();
    const retainedIds = new Set<string>();
    for (const { parentUuid, message } of retained) {
        const messages = state.orphanMessages.get(parentUuid) ?? [];
        messages.push(message);
        state.orphanMessages.set(parentUuid, messages);
        retainedIds.add(message.id);
    }
    return retainedIds;
}

export function estimateReducerStateBytes(state: ReducerState): number {
    return estimateApproximateBytes(state, MAX_RETAINED_SESSION_MESSAGE_BYTES);
}

function sweepReducerState(
    state: ReducerState,
    retainedMessageIds: Set<string>,
    limit: number,
): void {
    for (const id of state.messages.keys()) {
        if (!retainedMessageIds.has(id)) state.messages.delete(id);
    }
    trimMapToLimit(state.messages, limit);

    const survivingMessageIds = new Set(state.messages.keys());
    const survivingRealIds = new Set<string>();
    for (const message of state.messages.values()) {
        if (message.realID) survivingRealIds.add(message.realID);
    }

    for (const [ownerId, children] of state.sidechains) {
        const retainedChildren = children.filter((message) => survivingMessageIds.has(message.id));
        if (!survivingRealIds.has(ownerId) || retainedChildren.length === 0) {
            state.sidechains.delete(ownerId);
        } else {
            state.sidechains.set(ownerId, retainedChildren);
        }
    }
    trimMapToLimit(state.sidechains, limit);

    for (const [localId, messageId] of state.localIds) {
        if (!survivingMessageIds.has(messageId)) state.localIds.delete(localId);
    }
    for (const [toolId, messageId] of state.toolIdToMessageId) {
        if (!survivingMessageIds.has(messageId)) state.toolIdToMessageId.delete(toolId);
    }
    for (const [toolId, messageId] of state.sidechainToolIdToMessageId) {
        if (!survivingMessageIds.has(messageId)) state.sidechainToolIdToMessageId.delete(toolId);
    }
    retainRequiredAndRecentMapEntries(
        state.messageIds,
        (messageId, internalId) => survivingMessageIds.has(internalId) || survivingRealIds.has(messageId),
        limit,
    );

    const survivingToolIds = new Set([
        ...state.toolIdToMessageId.keys(),
        ...state.sidechainToolIdToMessageId.keys(),
    ]);
    for (const permissionId of state.permissions.keys()) {
        if (!survivingToolIds.has(permissionId)) state.permissions.delete(permissionId);
    }

    trimMapToLimit(state.localIds, limit);
    trimMapToLimit(state.toolIdToMessageId, limit);
    trimMapToLimit(state.sidechainToolIdToMessageId, limit);
    trimMapToLimit(state.permissions, limit);

    const tracer = state.tracerState;
    for (const [messageId, task] of tracer.taskTools) {
        if (!survivingRealIds.has(task.messageId)) tracer.taskTools.delete(messageId);
    }
    for (const [prompt, taskId] of tracer.promptToTaskId) {
        if (!survivingRealIds.has(taskId)) tracer.promptToTaskId.delete(prompt);
    }
    for (const [uuid, ownerId] of tracer.uuidToSidechainId) {
        if (!survivingRealIds.has(ownerId)) tracer.uuidToSidechainId.delete(uuid);
    }
    for (const [toolCallId, messageId] of tracer.toolCallToMessageId) {
        if (!survivingRealIds.has(messageId)) tracer.toolCallToMessageId.delete(toolCallId);
    }

    trimMapToLimit(tracer.taskTools, limit);
    trimMapToLimit(tracer.promptToTaskId, limit);
    trimMapToLimit(tracer.uuidToSidechainId, limit);
    trimMapToLimit(tracer.toolCallToMessageId, limit);
    const orphanIds = boundOrphanMessages(tracer, limit);

    const processedIds = [...tracer.processedIds];
    const requiredProcessedIds = processedIds
        .filter((id) => survivingRealIds.has(id) || orphanIds.has(id))
        .slice(-limit);
    const requiredProcessedSet = new Set(requiredProcessedIds);
    const optionalProcessedCapacity = limit - requiredProcessedIds.length;
    const optionalProcessedIds = optionalProcessedCapacity > 0
        ? processedIds.filter((id) => !requiredProcessedSet.has(id)).slice(-optionalProcessedCapacity)
        : [];
    tracer.processedIds.clear();
    for (const id of [...optionalProcessedIds, ...requiredProcessedIds]) tracer.processedIds.add(id);
}

function dropOldestOrphanBatch(state: TracerState): boolean {
    const entries: { parentUuid: string; message: NormalizedMessage }[] = [];
    for (const [parentUuid, messages] of state.orphanMessages) {
        for (const message of messages) entries.push({ parentUuid, message });
    }
    if (entries.length === 0) return false;
    entries.sort((left, right) => right.message.createdAt - left.message.createdAt);
    const keepCount = Math.max(0, entries.length - Math.max(1, Math.ceil(entries.length / 4)));
    state.orphanMessages.clear();
    for (const { parentUuid, message } of entries.slice(0, keepCount).reverse()) {
        const messages = state.orphanMessages.get(parentUuid) ?? [];
        messages.push(message);
        state.orphanMessages.set(parentUuid, messages);
    }
    return true;
}

function removeOldestReducerMessageGroup(
    state: ReducerState,
    retainedMessageIds: Set<string>,
): boolean {
    const childIds = new Set<string>();
    for (const children of state.sidechains.values()) {
        for (const child of children) childIds.add(child.id);
    }
    const roots = [...state.messages.values()]
        .filter((message) => !childIds.has(message.id))
        .sort((left, right) => left.createdAt - right.createdAt);
    const oldest = roots[0] ?? [...state.messages.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) return false;

    const visited = new Set<string>();
    const removeTree = (message: ReducerMessage): void => {
        if (visited.has(message.id)) return;
        visited.add(message.id);
        retainedMessageIds.delete(message.id);
        if (!message.realID) return;
        for (const child of state.sidechains.get(message.realID) ?? []) removeTree(child);
    };
    removeTree(oldest);
    return true;
}

function dropOldestOpaqueIndexBatch(state: ReducerState): boolean {
    const survivingRealIds = new Set<string>();
    for (const message of state.messages.values()) {
        if (message.realID) survivingRealIds.add(message.realID);
    }
    const optionalMessageIds = [...state.messageIds.keys()]
        .filter((id) => !survivingRealIds.has(id));
    const optionalProcessedIds = [...state.tracerState.processedIds]
        .filter((id) => !survivingRealIds.has(id));
    const optionalCount = optionalMessageIds.length + optionalProcessedIds.length;
    if (optionalCount === 0) return false;

    let toRemove = Math.max(1, Math.ceil(optionalCount / 4));
    for (const id of optionalMessageIds) {
        if (toRemove <= 0) break;
        state.messageIds.delete(id);
        toRemove -= 1;
    }
    for (const id of optionalProcessedIds) {
        if (toRemove <= 0) break;
        state.tracerState.processedIds.delete(id);
        toRemove -= 1;
    }
    return true;
}

/**
 * Keep every reducer-owned relationship inside the same bounded message
 * window as the rendered session history. References are swept together so a
 * retained tool remains correlatable while results for evicted tools are
 * ignored instead of recreating hidden history.
 */
export function pruneReducerState(
    state: ReducerState,
    retainedMessages?: readonly Message[],
    limit = MAX_STORED_SESSION_MESSAGES,
    byteLimit = MAX_RETAINED_SESSION_MESSAGE_BYTES,
): Set<string> {
    const retainedMessageIds = retainedMessages
        ? new Set<string>()
        : selectRecentReducerMessageIds(state, limit, byteLimit);
    if (retainedMessages) {
        collectMessageTreeIds(retainedMessages, retainedMessageIds);
    }

    while (true) {
        sweepReducerState(state, retainedMessageIds, limit);
        if (estimateApproximateBytes(state, byteLimit) <= byteLimit) {
            return new Set(state.messages.keys());
        }
        if (dropOldestOrphanBatch(state.tracerState)) continue;
        if (dropOldestOpaqueIndexBatch(state)) continue;
        if (removeOldestReducerMessageGroup(state, retainedMessageIds)) continue;
        if (state.latestTodos) {
            state.latestTodos = undefined;
            continue;
        }
        state.messageIds.clear();
        state.tracerState.processedIds.clear();
        return new Set(state.messages.keys());
    }
}

const ENABLE_LOGGING = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeToolInputs(existingInput: unknown, nextInput: unknown): unknown {
    if (isRecord(existingInput) && isRecord(nextInput)) {
        return { ...nextInput, ...existingInput };
    }
    return nextInput ?? existingInput;
}

function getSidechainOwner(state: ReducerState, sidechainId: string): ReducerMessage | null {
    const ownerMessageId = state.messageIds.get(sidechainId);
    if (ownerMessageId) {
        const owner = state.messages.get(ownerMessageId);
        if (owner?.tool) {
            return owner;
        }
    }

    for (const message of state.messages.values()) {
        if (message.realID === sidechainId && message.tool) {
            return message;
        }
    }

    return null;
}

function getVisibleSidechainPrompt(owner: ReducerMessage | null): string | null {
    const prompt = owner?.tool?.input?.prompt;
    if (typeof prompt !== 'string') {
        return null;
    }
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : null;
}

function isDuplicateSidechainPrompt(
    existingSidechain: ReducerMessage[],
    ownerPrompt: string | null,
    text: string,
): boolean {
    if (existingSidechain.length > 0 || !ownerPrompt) {
        return false;
    }

    return text.trim() === ownerPrompt;
}

export type ReducerResult = {
    messages: Message[];
    todos?: TodoItem[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    hasReadyEvent?: boolean;
};

function updateLatestTodos(state: ReducerState, value: unknown, timestamp: number) {
    const parsed = TodoItemsSchema.safeParse(value);
    if (!parsed.success) {
        return;
    }

    if (!state.latestTodos || timestamp > state.latestTodos.timestamp) {
        state.latestTodos = {
            todos: parsed.data,
            timestamp,
        };
    }
}

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
    if (ENABLE_LOGGING) {
        console.log('Reducer started');
        if (agentState?.requests) {
            console.log('Reducer received pending requests');
        }
        if (agentState?.completedRequests) {
            console.log('Reducer received completed requests');
        }
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    //
    // Phase 0.5: Message-to-Event Conversion
    // Convert certain messages to events before normal processing
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0.5: Message-to-Event Conversion`);
    }

    const messagesToProcess: NormalizedMessage[] = [];
    const convertedEvents: { message: NormalizedMessage, event: AgentEvent }[] = [];

    for (const msg of nonSidechainMessages) {
        // Check if we've already processed this message
        if (msg.role === 'user' && msg.localId && state.localIds.has(msg.localId)) {
            continue;
        }
        if (state.messageIds.has(msg.id)) {
            continue;
        }

        // Filter out ready events completely - they should not create any message
        if (msg.role === 'event' && msg.content.type === 'ready') {
            // Mark as processed to prevent duplication but don't add to messages
            state.messageIds.set(msg.id, msg.id);
            hasReadyEvent = true;
            continue;
        }

        // Session protocol turn-start markers are lifecycle-only and should stay invisible.
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Turn started') {
            state.messageIds.set(msg.id, msg.id);
            continue;
        }

        // Handle context reset events - reset state and let the message be shown
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Context was reset') {
            // Reset todos to empty array and reset usage to zero
            state.latestTodos = {
                todos: [],
                timestamp: msg.createdAt  // Use message timestamp, not current time
            };
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Handle compaction completed events - reset context but keep todos
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Compaction completed') {
            // Reset usage/context to zero but keep todos unchanged
            state.latestUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreation: 0,
                cacheRead: 0,
                contextSize: 0,
                timestamp: msg.createdAt  // Use message timestamp to avoid blocking older usage data
            };
            // Don't continue - let the event be processed normally to create a message
        }

        // Try to parse message as event
        const event = parseMessageAsEvent(msg);
        if (event) {
            if (ENABLE_LOGGING) {
                console.log('[REDUCER] Converting a message to an event');
            }
            convertedEvents.push({ message: msg, event });
            // Mark as processed to prevent duplication
            state.messageIds.set(msg.id, msg.id);
            if (msg.role === 'user' && msg.localId) {
                state.localIds.set(msg.localId, msg.id);
            }
        } else {
            messagesToProcess.push(msg);
        }
    }

    // Process converted events immediately
    for (const { message, event } of convertedEvents) {
        const mid = allocateId();
        state.messages.set(mid, {
            id: mid,
            realID: message.id,
            role: 'agent',
            createdAt: message.createdAt,
            event: event,
            tool: null,
            text: null,
            meta: message.meta,
        });
        changed.add(mid);
    }

    // Update nonSidechainMessages to only include messages that weren't converted
    nonSidechainMessages = messagesToProcess;

    // Build a set of incoming tool IDs for quick lookup
    const incomingToolIds = new Set<string>();
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    incomingToolIds.add(c.id);
                }
            }
        }
    }

    //
    // Phase 0: Process AgentState permissions
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 0: Processing AgentState`);
    }
    if (agentState) {
        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // Skip if this permission is also in completedRequests (completed takes precedence)
                if (agentState.completedRequests && agentState.completedRequests[permId]) {
                    continue;
                }

                // Check if we already have a message for this permission ID
                const existingMessageId = state.toolIdToMessageId.get(permId);
                if (existingMessageId) {
                    // Update existing tool message with permission info
                    const message = state.messages.get(existingMessageId);
                    if (message?.tool && !message.tool.permission) {
                        if (ENABLE_LOGGING) {
                            console.log('Reducer updated an existing tool permission');
                        }
                        message.tool.permission = {
                            id: permId,
                            status: 'pending'
                        };
                        changed.add(existingMessageId);
                    }
                } else {
                    if (ENABLE_LOGGING) {
                        console.log('Reducer created a permission message');
                    }

                    // Create a new tool message for the permission request
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: request.tool,
                        state: 'running' as const,
                        input: request.arguments,
                        createdAt: request.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: null,
                        description: null,
                        result: undefined,
                        permission: {
                            id: permId,
                            status: 'pending'
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: request.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: 'pending'
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // Check if we have a message for this permission ID
                const messageId = state.toolIdToMessageId.get(permId);
                if (messageId) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution with approval
                        if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            continue;
                        }

                        // Skip if permission already has date (came from tool result - preferred over agentState)
                        if (message.tool.permission?.date) {
                            continue;
                        }

                        // Check if we need to update ANY field
                        const needsUpdate =
                            message.tool.permission?.status !== completed.status ||
                            message.tool.permission?.reason !== completed.reason ||
                            message.tool.permission?.mode !== completed.mode ||
                            message.tool.permission?.allowedTools !== completed.allowedTools ||
                            message.tool.permission?.decision !== completed.decision;

                        if (!needsUpdate) {
                            continue;
                        }

                        let hasChanged = false;

                        // Update permission status
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                mode: completed.mode || undefined,
                                allowedTools: completed.allowedTools || undefined,
                                decision: completed.decision || undefined,
                                reason: completed.reason || undefined
                            };
                            hasChanged = true;
                        } else {
                            // Update all fields
                            message.tool.permission.status = completed.status;
                            message.tool.permission.mode = completed.mode || undefined;
                            message.tool.permission.allowedTools = completed.allowedTools || undefined;
                            message.tool.permission.decision = completed.decision || undefined;
                            if (completed.reason) {
                                message.tool.permission.reason = completed.reason;
                            }
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        // Update stored permission
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        });

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        if (ENABLE_LOGGING) {
                            console.log('Reducer stored an incoming tool permission');
                        }
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, {
                            tool: completed.tool,
                            arguments: completed.arguments,
                            createdAt: completed.createdAt || Date.now(),
                            completedAt: completed.completedAt || undefined,
                            status: completed.status,
                            reason: completed.reason || undefined
                        });
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? 'Approved'
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        role: 'agent',
                        createdAt: completed.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                    });

                    state.toolIdToMessageId.set(permId, mid);

                    // Store permission details
                    state.permissions.set(permId, {
                        tool: completed.tool,
                        arguments: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        completedAt: completed.completedAt || undefined,
                        status: completed.status,
                        reason: completed.reason || undefined,
                        mode: completed.mode || undefined,
                        allowedTools: completed.allowedTools || undefined,
                        decision: completed.decision || undefined
                    });

                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 1: Process non-sidechain user messages and text messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                localId: msg.localId,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
                claudeUuid: msg.claudeUuid,
                codexItemId: msg.codexItemId,
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);

            changed.add(mid);
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Phase 2: Processing tool calls`);
    }
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        if (ENABLE_LOGGING) {
                            console.log('Reducer found an existing tool message');
                        }
                        // Update existing message with tool execution details
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            message.realID = msg.id;
                            message.tool.input = mergeToolInputs(message.tool.input, c.input);
                            message.tool.description = c.description;
                            message.tool.startedAt = msg.createdAt;
                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                            }
                            changed.add(existingMessageId);

                        }
                    } else {
                        if (ENABLE_LOGGING) {
                            console.log('Reducer created a tool message');
                        }
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? mergeToolInputs(permission.arguments, c.input) : c.input,
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            if (ENABLE_LOGGING) {
                                console.log('Reducer found a stored tool permission');
                            }
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        let mid = allocateId();
                        state.messages.set(mid, {
                            id: mid,
                            realID: msg.id,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                        });

                        state.toolIdToMessageId.set(c.id, mid);
                        changed.add(mid);

                    }
                }
            }
        }
    }

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    // Find the message containing this tool
                    let messageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (!messageId) {
                        continue;
                    }

                    let message = state.messages.get(messageId);
                    if (!message || !message.tool) {
                        continue;
                    }

                    if (message.tool.state !== 'running') {
                        continue;
                    }

                    // Update tool state and result
                    message.tool.state = c.is_error ? 'error' : 'completed';
                    message.tool.result = c.content;
                    message.tool.completedAt = msg.createdAt;

                    // Update permission data if provided by backend
                    if (c.permissions) {
                        // Merge with existing permission to preserve decision field from agentState
                        if (message.tool.permission) {
                            // Preserve existing decision if not provided in tool result
                            const existingDecision = message.tool.permission.decision;
                            message.tool.permission = {
                                ...message.tool.permission,
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision || existingDecision
                            };
                        } else {
                            message.tool.permission = {
                                id: c.tool_use_id,
                                status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                date: c.permissions.date,
                                mode: c.permissions.mode,
                                allowedTools: c.permissions.allowedTools,
                                decision: c.permissions.decision
                            };
                        }
                    }

                    if (message.tool.name === 'TodoWrite' && !c.is_error) {
                        updateLatestTodos(state, message.tool.result?.newTodos, msg.createdAt);
                    }

                    changed.add(messageId);
                }
            }
        }
    }

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        // Get or create the sidechain array for this Task
        const existingSidechain = state.sidechains.get(msg.sidechainId) || [];
        const owner = getSidechainOwner(state, msg.sidechainId);
        const ownerPrompt = getVisibleSidechainPrompt(owner);

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            if (isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, msg.content[0].prompt)) {
                state.sidechains.set(msg.sidechainId, existingSidechain);
                continue;
            }
            let mid = allocateId();
            let userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    const text = c.type === 'thinking' ? c.thinking : c.text;
                    if (c.type === 'text' && isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, text)) {
                        continue;
                    }
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    let textMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'tool-call') {
                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                } else if (c.type === 'tool-result') {
                    // Process tool result in sidechain - update BOTH messages

                    // Update the sidechain tool message
                    let sidechainMessageId = state.sidechainToolIdToMessageId.get(c.tool_use_id);
                    if (sidechainMessageId) {
                        let sidechainMessage = state.messages.get(sidechainMessageId);
                        if (sidechainMessage && sidechainMessage.tool && sidechainMessage.tool.state === 'running') {
                            sidechainMessage.tool.state = c.is_error ? 'error' : 'completed';
                            sidechainMessage.tool.result = c.content;
                            sidechainMessage.tool.completedAt = msg.createdAt;

                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (sidechainMessage.tool.permission) {
                                    const existingDecision = sidechainMessage.tool.permission.decision;
                                    sidechainMessage.tool.permission = {
                                        ...sidechainMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    sidechainMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }
                        }
                    }

                    // Also update the main permission message if it exists
                    let permissionMessageId = state.toolIdToMessageId.get(c.tool_use_id);
                    if (permissionMessageId) {
                        let permissionMessage = state.messages.get(permissionMessageId);
                        if (permissionMessage && permissionMessage.tool && permissionMessage.tool.state === 'running') {
                            permissionMessage.tool.state = c.is_error ? 'error' : 'completed';
                            permissionMessage.tool.result = c.content;
                            permissionMessage.tool.completedAt = msg.createdAt;

                            // Update permission data if provided by backend
                            if (c.permissions) {
                                // Merge with existing permission to preserve decision field from agentState
                                if (permissionMessage.tool.permission) {
                                    const existingDecision = permissionMessage.tool.permission.decision;
                                    permissionMessage.tool.permission = {
                                        ...permissionMessage.tool.permission,
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision || existingDecision
                                    };
                                } else {
                                    permissionMessage.tool.permission = {
                                        id: c.tool_use_id,
                                        status: c.permissions.result === 'approved' ? 'approved' : 'denied',
                                        date: c.permissions.date,
                                        mode: c.permissions.mode,
                                        allowedTools: c.permissions.allowedTools,
                                        decision: c.permissions.decision
                                    };
                                }
                            }

                            changed.add(permissionMessageId);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(msg.sidechainId, existingSidechain);

        // Find the Task tool message that owns this sidechain and mark it as changed
        // msg.sidechainId is the realID of the Task message
        for (const [internalId, message] of state.messages) {
            if (message.realID === msg.sidechainId && message.tool) {
                changed.add(internalId);
                break;
            }
        }
    }

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            changed.add(mid);
        }
    }

    pruneReducerState(state);

    //
    // Collect changed messages (only root-level messages)
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (!existing) continue;

        let message = convertReducerMessageToMessage(existing, state);
        if (message) {
            newMessages.push(message);
        }
    }

    //
    // Debug changes
    //

    if (ENABLE_LOGGING) {
        console.log('Reducer processed messages');
        console.log('Reducer applied message changes');
    }

    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number) {
    // Only update if this is newer than the current latest usage
    if (!state.latestUsage || timestamp > state.latestUsage.timestamp) {
        state.latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            contextSize: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens,
            timestamp: timestamp
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: reducerMsg.localId ?? null,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(reducerMsg.meta?.displayText && { displayText: reducerMsg.meta.displayText }),
            ...(reducerMsg.claudeUuid && { claudeUuid: reducerMsg.claudeUuid }),
            ...(reducerMsg.codexItemId && { codexItemId: reducerMsg.codexItemId }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively
        let childMessages: Message[] = [];
        let children = reducerMsg.realID ? state.sidechains.get(reducerMsg.realID) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        return {
            id: reducerMsg.id,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool: { ...reducerMsg.tool },
            children: childMessages,
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta
        };
    }

    return null;
}
