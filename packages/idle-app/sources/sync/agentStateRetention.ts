import {
    estimateApproximateBytes,
    MAX_RETAINED_SESSION_MESSAGE_BYTES,
    MAX_STORED_SESSION_MESSAGES,
} from './sessionMessageLimits';
import type { AgentState } from './storageTypes';

type TimestampedEntry = { createdAt?: number | null };
type RecordEntry<T> = { id: string; value: T };

function collectNewestEntries<T extends TimestampedEntry>(
    record: Record<string, T> | null | undefined,
    allowedIds?: ReadonlySet<string>,
): RecordEntry<T>[] {
    const retained: RecordEntry<T>[] = [];
    if (!record) return retained;

    for (const id in record) {
        if (!Object.prototype.hasOwnProperty.call(record, id) || (allowedIds && !allowedIds.has(id))) {
            continue;
        }
        const candidate = { id, value: record[id] };
        if (retained.length < MAX_STORED_SESSION_MESSAGES) {
            retained.push(candidate);
            continue;
        }
        let oldestIndex = 0;
        for (let index = 1; index < retained.length; index += 1) {
            if ((retained[index].value.createdAt ?? 0) < (retained[oldestIndex].value.createdAt ?? 0)) {
                oldestIndex = index;
            }
        }
        if ((candidate.value.createdAt ?? 0) > (retained[oldestIndex].value.createdAt ?? 0)) {
            retained[oldestIndex] = candidate;
        }
    }

    return retained.sort((left, right) => (right.value.createdAt ?? 0) - (left.value.createdAt ?? 0));
}

export function retainAgentStateWithinBudget(
    agentState: AgentState | null | undefined,
    allowedToolIds?: ReadonlySet<string>,
): AgentState | null {
    if (!agentState) return null;

    const retained: AgentState = {};
    if (agentState.controlledByUser !== undefined) {
        retained.controlledByUser = agentState.controlledByUser;
    }

    let remainingEntries = MAX_STORED_SESSION_MESSAGES;
    let remainingBytes = MAX_RETAINED_SESSION_MESSAGE_BYTES - 256;
    const retainedRequestIds: string[] = [];
    const retainedCompletedIds: string[] = [];

    const addEntries = <T extends TimestampedEntry>(
        entries: RecordEntry<T>[],
        target: Record<string, T>,
        retainedIds: string[],
    ) => {
        for (const { id, value } of entries) {
            if (remainingEntries <= 0 || remainingBytes <= 0) break;
            const estimated = estimateApproximateBytes({ [id]: value }, remainingBytes);
            const retainedCost = estimated + 64;
            if (estimated > remainingBytes || retainedCost > remainingBytes) continue;
            target[id] = value;
            retainedIds.push(id);
            remainingEntries -= 1;
            remainingBytes -= retainedCost;
        }
    };

    const requests: NonNullable<AgentState['requests']> = {};
    addEntries(collectNewestEntries(agentState.requests, allowedToolIds), requests, retainedRequestIds);
    if (retainedRequestIds.length > 0) retained.requests = requests;

    if (agentState.agentGoalStatus) {
        const estimatedGoal = estimateApproximateBytes(
            { agentGoalStatus: agentState.agentGoalStatus },
            remainingBytes,
        );
        if (estimatedGoal <= remainingBytes && estimatedGoal + 64 <= remainingBytes) {
            retained.agentGoalStatus = agentState.agentGoalStatus;
            remainingBytes -= estimatedGoal + 64;
        }
    }

    const completedRequests: NonNullable<AgentState['completedRequests']> = {};
    addEntries(
        collectNewestEntries(agentState.completedRequests, allowedToolIds),
        completedRequests,
        retainedCompletedIds,
    );
    if (retainedCompletedIds.length > 0) retained.completedRequests = completedRequests;

    while (estimateApproximateBytes(retained) > MAX_RETAINED_SESSION_MESSAGE_BYTES) {
        const oldestCompletedId = retainedCompletedIds.pop();
        if (oldestCompletedId) {
            delete completedRequests[oldestCompletedId];
            if (retainedCompletedIds.length === 0) delete retained.completedRequests;
            continue;
        }
        if (retained.agentGoalStatus) {
            delete retained.agentGoalStatus;
            continue;
        }
        const oldestRequestId = retainedRequestIds.pop();
        if (oldestRequestId) {
            delete requests[oldestRequestId];
            if (retainedRequestIds.length === 0) delete retained.requests;
            continue;
        }
        break;
    }

    return retained;
}
