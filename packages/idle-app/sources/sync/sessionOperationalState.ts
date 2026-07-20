import type { AgentState, Metadata, Session } from './storageTypes';

// Provenance is deliberately process-local and attached to the exact retained
// objects. A relay-owned identifier or version number cannot promote legacy
// display data into an operational input.
const authenticatedAgentStatesForEffects = new WeakSet<object>();
const authenticatedMetadataForEffects = new WeakSet<object>();

export function isAgentStateAuthenticatedForEffects(value: unknown): boolean {
    return typeof value === 'object'
        && value !== null
        && authenticatedAgentStatesForEffects.has(value);
}

export function isMetadataAuthenticatedForEffects(value: unknown): boolean {
    return typeof value === 'object'
        && value !== null
        && authenticatedMetadataForEffects.has(value);
}

export function getOperationalAgentState(
    value: AgentState | null | undefined,
): AgentState | null {
    return value && isAgentStateAuthenticatedForEffects(value) ? value : null;
}

export function getOperationalSessionMetadata(
    value: Metadata | null | undefined,
): Metadata | null {
    return value && isMetadataAuthenticatedForEffects(value) ? value : null;
}

export function markAgentStateAuthenticatedForEffects(value: unknown): void {
    if (typeof value === 'object' && value !== null) {
        authenticatedAgentStatesForEffects.add(value);
    }
}

export function markMetadataAuthenticatedForEffects(value: unknown): void {
    if (typeof value === 'object' && value !== null) {
        authenticatedMetadataForEffects.add(value);
    }
}

export function getOperationalSessionIndicators(session: Pick<Session, 'agentState'>): {
    controlledByUser: boolean;
    hasPendingPermissions: boolean;
    agentState: AgentState | null;
} {
    const agentState = getOperationalAgentState(session.agentState);
    return {
        controlledByUser: agentState?.controlledByUser === true,
        hasPendingPermissions: Boolean(
            agentState?.requests && Object.keys(agentState.requests).length > 0,
        ),
        agentState,
    };
}
