import { describe, expect, it } from 'vitest';

import { retainAgentStateWithinBudget } from './agentStateRetention';
import {
    estimateApproximateBytes,
    MAX_RETAINED_SESSION_MESSAGE_BYTES,
} from './sessionMessageLimits';
import type { AgentState } from './storageTypes';

describe('AgentState retained-memory budget', () => {
    it('keeps one maximum-size pending request but bounds repeated payloads', () => {
        const maximumTransportPlaintext = 'P'.repeat(4 * 1024 * 1024);
        const requests: NonNullable<AgentState['requests']> = {};
        for (let index = 0; index < 10; index += 1) {
            requests[`request-${index}`] = {
                tool: 'Task',
                arguments: { payload: maximumTransportPlaintext },
                createdAt: index + 1,
            };
        }

        const retained = retainAgentStateWithinBudget({ requests });
        const retainedIds = Object.keys(retained?.requests ?? {});

        expect(retainedIds.length).toBeGreaterThanOrEqual(1);
        expect(retainedIds.length).toBeLessThan(10);
        expect(retainedIds).toContain('request-9');
        expect(estimateApproximateBytes(retained))
            .toBeLessThanOrEqual(MAX_RETAINED_SESSION_MESSAGE_BYTES);
    });

    it('uses the reducer surviving-tool graph and prioritizes pending requests', () => {
        const state: AgentState = {
            controlledByUser: true,
            requests: {
                pending: { tool: 'Write', arguments: { path: 'file.txt' }, createdAt: 2 },
                discarded: { tool: 'Read', arguments: { path: 'old.txt' }, createdAt: 1 },
            },
            completedRequests: {
                completed: {
                    tool: 'Bash',
                    arguments: { command: 'pwd' },
                    createdAt: 3,
                    completedAt: 4,
                    status: 'approved',
                },
            },
        };

        const retained = retainAgentStateWithinBudget(state, new Set(['pending', 'completed']));

        expect(retained).toEqual({
            controlledByUser: true,
            requests: { pending: state.requests?.pending },
            completedRequests: { completed: state.completedRequests?.completed },
        });
    });
});
