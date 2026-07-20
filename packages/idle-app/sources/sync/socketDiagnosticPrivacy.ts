const CONNECTION_FAILURE_MESSAGE = 'Connection failed. Check the relay URL, network, and account pairing.';

/**
 * Socket.IO error text can contain relay-controlled payloads, URLs, transport
 * internals, and local paths. The connection detail sheet needs an actionable
 * status, not the raw exception.
 */
export function getSafeConnectionErrorMessage(_error: unknown): string {
    return CONNECTION_FAILURE_MESSAGE;
}
