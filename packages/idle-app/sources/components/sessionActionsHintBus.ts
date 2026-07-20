/**
 * Module-scope subscriber bus that lets SessionActionsHint
 * dismiss itself the moment any session-row ⋯ button or long-press is used,
 * without threading a callback through 3+ component boundaries.
 *
 * Lifetime: a SessionActionsHint registers a dismiss callback on mount and
 * unregisters on unmount. Long-press handlers call notify() on every action
 * trigger. The bus has no dependencies and no state besides the listener set.
 */
const listeners = new Set<() => void>();

export function subscribeToSessionActionsTriggered(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

export function notifySessionActionsTriggered(): void {
    listeners.forEach((cb) => cb());
}
