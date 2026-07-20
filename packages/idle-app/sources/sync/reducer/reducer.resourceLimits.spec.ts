import { describe, expect, it } from 'vitest';

import {
    MAX_RETAINED_SESSION_MESSAGE_BYTES,
    MAX_STORED_SESSION_MESSAGES,
} from '../sessionMessageLimits';
import type { AgentState } from '../storageTypes';
import type { NormalizedMessage } from '../typesRaw';
import { createReducer, estimateReducerStateBytes, reducer, type ReducerState } from './reducer';

function expectReducerCollectionsBounded(state: ReducerState): void {
    const collections = [
        state.messages,
        state.messageIds,
        state.localIds,
        state.toolIdToMessageId,
        state.sidechainToolIdToMessageId,
        state.permissions,
        state.sidechains,
        state.tracerState.taskTools,
        state.tracerState.promptToTaskId,
        state.tracerState.uuidToSidechainId,
        state.tracerState.toolCallToMessageId,
        state.tracerState.orphanMessages,
        state.tracerState.processedIds,
    ];

    for (const collection of collections) {
        expect(collection.size).toBeLessThanOrEqual(MAX_STORED_SESSION_MESSAGES);
    }

    const sidechainMessages = [...state.sidechains.values()]
        .reduce((total, messages) => total + messages.length, 0);
    const orphanMessages = [...state.tracerState.orphanMessages.values()]
        .reduce((total, messages) => total + messages.length, 0);
    expect(sidechainMessages).toBeLessThanOrEqual(MAX_STORED_SESSION_MESSAGES);
    expect(orphanMessages).toBeLessThanOrEqual(MAX_STORED_SESSION_MESSAGES);
}

function taskMessage(index: number): NormalizedMessage {
    return {
        id: `task-message-${index}`,
        localId: null,
        createdAt: index * 2 + 2,
        role: 'agent',
        isSidechain: false,
        content: [{
            type: 'tool-call',
            id: `tool-${index}`,
            name: 'Task',
            input: { prompt: `prompt-${index}` },
            description: null,
            uuid: `task-uuid-${index}`,
            parentUUID: null,
        }],
    };
}

describe('reducer resource limits', () => {
    it('retains one allowed large message but bounds repeated plaintext and permission payloads', () => {
        const maximumTransportPlaintext = 'A'.repeat(4 * 1024 * 1024);
        const singleState = createReducer();
        const singleResult = reducer(singleState, [{
            id: 'single-large-message',
            localId: null,
            createdAt: 1,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'text',
                text: maximumTransportPlaintext,
                uuid: 'single-large-uuid',
                parentUUID: null,
            }],
        }]);

        expect(singleResult.messages).toHaveLength(1);
        expect(estimateReducerStateBytes(singleState))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);

        const repeatedState = createReducer();
        const repeatedMessages: NormalizedMessage[] = Array.from({ length: 10 }, (_, index) => ({
            id: `large-message-${index}`,
            localId: null,
            createdAt: index + 1,
            role: 'agent' as const,
            isSidechain: false,
            content: [{
                type: 'text' as const,
                text: maximumTransportPlaintext,
                uuid: `large-uuid-${index}`,
                parentUUID: null,
            }],
        }));
        reducer(repeatedState, repeatedMessages);

        expect(repeatedState.messages.size).toBeGreaterThanOrEqual(1);
        expect(repeatedState.messages.size).toBeLessThan(10);
        expect(estimateReducerStateBytes(repeatedState))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);

        const permissionState = createReducer();
        const completedRequests: NonNullable<AgentState['completedRequests']> = {};
        for (let index = 0; index < 10; index += 1) {
            completedRequests[`large-permission-${index}`] = {
                tool: 'Task',
                arguments: { payload: maximumTransportPlaintext },
                createdAt: index + 1,
                completedAt: index + 1,
                status: 'approved',
            };
        }
        reducer(permissionState, [], { completedRequests });

        expect(permissionState.permissions.size).toBeLessThan(10);
        expect(estimateReducerStateBytes(permissionState))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);
    });

    it('bounds mixed message, tool, permission, and tracer indexes while retaining recent correlation', () => {
        const state = createReducer();
        const count = MAX_STORED_SESSION_MESSAGES + 50;
        const messages: NormalizedMessage[] = [];
        const requests: NonNullable<AgentState['requests']> = {};

        for (let index = 0; index < count; index += 1) {
            messages.push({
                id: `user-message-${index}`,
                localId: `local-${index}`,
                createdAt: index * 2 + 3,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: `message ${index}` },
            });
            messages.push(taskMessage(index));
            requests[`tool-${index}`] = {
                tool: 'Task',
                arguments: { prompt: `prompt-${index}` },
                createdAt: index * 2 + 2,
            };
        }

        reducer(state, messages, { requests });

        expectReducerCollectionsBounded(state);
        expect(state.toolIdToMessageId.has(`tool-${count - 1}`)).toBe(true);
        expect(state.toolIdToMessageId.has('tool-0')).toBe(false);

        const result = reducer(state, [{
            id: 'latest-tool-result',
            localId: null,
            createdAt: count * 2 + 1,
            role: 'agent',
            isSidechain: false,
            content: [{
                type: 'tool-result',
                tool_use_id: `tool-${count - 1}`,
                content: 'done',
                is_error: false,
                uuid: 'latest-result-uuid',
                parentUUID: null,
            }],
        }]);

        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({
            kind: 'tool-call',
            tool: { state: 'completed', result: 'done' },
        });
        expectReducerCollectionsBounded(state);
    });

    it('bounds sidechain relationships and unresolved orphan buffers', () => {
        const state = createReducer();
        const count = MAX_STORED_SESSION_MESSAGES + 50;
        const relatedMessages: NormalizedMessage[] = [];

        for (let index = 0; index < count; index += 1) {
            relatedMessages.push(taskMessage(index), {
                id: `sidechain-root-${index}`,
                localId: null,
                createdAt: index * 2 + 3,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: `sidechain-uuid-${index}`,
                    prompt: `prompt-${index}`,
                }],
            });
        }

        reducer(state, relatedMessages);
        expectReducerCollectionsBounded(state);

        const unresolvedOrphans: NormalizedMessage[] = Array.from({ length: count }, (_, index) => ({
            id: `orphan-${index}`,
            localId: null,
            createdAt: count * 2 + index,
            role: 'agent' as const,
            isSidechain: true,
            content: [{
                type: 'text' as const,
                text: `orphan ${index}`,
                uuid: `orphan-uuid-${index}`,
                parentUUID: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
            }],
        }));

        reducer(state, unresolvedOrphans);
        expectReducerCollectionsBounded(state);
    });
});
