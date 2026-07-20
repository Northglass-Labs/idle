interface HandshakeAuthSocket {
    handshake: {
        auth: unknown;
    };
}

export interface ConsumedSocketHandshakeAuth {
    token: string | undefined;
    clientType: unknown;
    sessionId: unknown;
    machineId: unknown;
    happyClient: string | undefined;
    appState: string | undefined;
}

function asAuthRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

/**
 * Copy the small allowlist needed for admission, then remove all client auth
 * fields from the live Socket.IO handshake before any asynchronous work.
 * Cluster adapters serialize the handshake during remote socket queries.
 */
export function consumeSocketHandshakeAuth(
    socket: HandshakeAuthSocket,
): ConsumedSocketHandshakeAuth {
    const auth = asAuthRecord(socket.handshake.auth);
    socket.handshake.auth = {};

    return {
        token: typeof auth.token === 'string' ? auth.token : undefined,
        clientType: auth.clientType,
        sessionId: auth.sessionId,
        machineId: auth.machineId,
        happyClient: typeof auth.happyClient === 'string' ? auth.happyClient : undefined,
        appState: typeof auth.appState === 'string' ? auth.appState : undefined,
    };
}
