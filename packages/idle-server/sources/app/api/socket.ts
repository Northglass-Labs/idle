import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { getMetricsLabelsFromSocket, redisStreamLagMsGauge, websocketConnectionsGauge, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { getSocketRateLimitKey } from "./requestSecurity";
import { db } from "@/storage/db";
import { onAuthorizedSocketEvent } from "./socket/socketScope";
import { pendingSocketAdmissions } from './socket/pendingSocketAdmissions';
import { prepareSocketAdmission } from './socket/socketAdmission';
import {
    connectionBurstLimiter,
    CONNECT_BURST_WINDOW_MS,
} from './socket/connectionBurstLimit';
import { consumeSocketHandshakeAuth } from './socket/socketHandshakeAuth';

async function getSessionAuthorizationGeneration(accountId: string, sessionId: string): Promise<number | null> {
    const session = await db.session.findFirst({
        where: { id: sessionId, accountId },
        select: { createdAt: true },
    });
    return session?.createdAt.getTime() ?? null;
}

async function getMachineAuthorizationGeneration(accountId: string, machineId: string): Promise<number | null> {
    const machine = await db.machine.findFirst({
        where: { id: machineId, accountId },
        select: { createdAt: true },
    });
    return machine?.createdAt.getTime() ?? null;
}

// Periodic prune is independent from the O(1) request path. A full source
// store rejects new keys until the next sweep instead of turning eviction into
// a rate-limit bypass or an attacker-triggered O(N) operation.
setInterval(() => {
    connectionBurstLimiter.prune();
}, CONNECT_BURST_WINDOW_MS).unref();

export function startSocket(app: Fastify, allowedOrigins: string[]) {
    const io = new Server(app.server, {
        // Socket.IO has an independent CORS boundary and must use the same
        // explicit origins as Fastify when credentials are enabled.
        cors: {
            origin: allowedOrigins,
            methods: ["GET", "POST", "OPTIONS"],
            credentials: true,
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false,
    });

    // Multi-process support: attach Redis streams adapter when REDIS_URL is set
    if (process.env.REDIS_URL) {
        const streamClient = new Redis(process.env.REDIS_URL);
        io.adapter(createAdapter(streamClient, { maxLen: 200000, readCount: 2000 }));
        log({ module: 'websocket' }, 'Redis streams adapter enabled for multi-process support');

        // Track stream reader lag: wrap onRawMessage to capture last-read offset,
        // then periodically compare against stream HEAD.
        let lastReadOffset = "0-0";
        const adapter = io.of("/").adapter as any;
        const origOnRawMessage = adapter.onRawMessage.bind(adapter);
        adapter.onRawMessage = (msg: any, offset: string) => {
            lastReadOffset = offset;
            return origOnRawMessage(msg, offset);
        };
        setInterval(async () => {
            try {
                const info = await streamClient.xinfo("STREAM", "socket.io") as any[];
                const headId = String(info[info.indexOf("last-generated-id") + 1]);
                const headMs = parseInt(headId.split("-")[0]);
                const readMs = parseInt(lastReadOffset.split("-")[0]);
                redisStreamLagMsGauge.set(headMs - readMs);
            } catch { /* stream may not exist yet */ }
        }, 5000);
    }

    // Initialize event router with Socket.IO server instance
    eventRouter.init(io, {
        distributePendingAdmissionCancellation: Boolean(process.env.REDIS_URL),
    });

    // Auth runs in middleware so it completes BEFORE the client's `connect`
    // event fires. Without this, the async verifyToken in the connection
    // callback creates a window where client events (rpc-register, rpc-call)
    // arrive before handlers are attached — and get silently dropped.
    io.use(async (socket, next) => {
        // Socket.IO cluster adapters serialize the live handshake for remote
        // socket queries. Consume and clear every client-supplied auth field
        // before an await so no bearer can enter an adapter response.
        const handshakeAuth = consumeSocketHandshakeAuth(socket);

        // Enforce per-peer burst protection before authentication.
        // Raw CDN headers are never trusted. Only a loopback reverse proxy may
        // supply the rightmost X-Forwarded-For peer, matching Fastify's trust
        // boundary without collapsing every nginx client into one bucket.
        const ip = getSocketRateLimitKey(socket.handshake);
        if (!connectionBurstLimiter.allow(ip)) {
            if (connectionBurstLimiter.shouldLogRejection()) {
                log({ module: 'websocket', level: 'warn' }, 'Rejected connection burst');
            }
            next(new Error('Too many connections; slow down.'));
            return;
        }
        const { token, clientType, sessionId, machineId } = handshakeAuth;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            next(new Error('Missing authentication token'));
            return;
        }

        const admission = await prepareSocketAdmission({
            socket,
            token,
            claim: { clientType, sessionId, machineId },
            auth,
            ownership: {
                getSessionGeneration: getSessionAuthorizationGeneration,
                getMachineGeneration: getMachineAuthorizationGeneration,
            },
            admissions: pendingSocketAdmissions,
        });
        if (!admission.ok) {
            log({ module: 'websocket' }, 'Rejected socket admission');
            next(new Error(admission.error));
            return;
        }
        const headerHappyClient = socket.handshake.headers['x-happy-client'];
        socket.data.happyClient = handshakeAuth.happyClient
            || (typeof headerHappyClient === 'string' ? headerHappyClient : undefined)
            || undefined;
        if (admission.scope.clientType === 'user-scoped' && handshakeAuth.appState) {
            socket.data.appState = handshakeAuth.appState === 'active' ? 'active' : 'background';
        }
        next();
    });

    io.on("connection", (socket) => {
        const userId = socket.data.userId as string;
        const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.data.sessionId as string | undefined;
        const machineId = socket.data.machineId as string | undefined;
        const authorizationGeneration = socket.data.authorizationGeneration as number | undefined;
        const accountAuthorizationGeneration = socket.data.accountAuthorizationGeneration as number | undefined;
        const labels = getMetricsLabelsFromSocket(socket);

        if (
            typeof accountAuthorizationGeneration !== 'number'
            || !Number.isSafeInteger(accountAuthorizationGeneration)
            || (clientType === 'session-scoped' && (
                !sessionId
                || typeof authorizationGeneration !== 'number'
                || !Number.isSafeInteger(authorizationGeneration)
            ))
            || (clientType === 'machine-scoped' && (
                !machineId
                || typeof authorizationGeneration !== 'number'
                || !Number.isSafeInteger(authorizationGeneration)
            ))
        ) {
            log({ module: 'websocket' }, 'Rejected incomplete socket capability');
            socket.disconnect(true);
            return;
        }

        const pendingAdmission = pendingSocketAdmissions.get(userId, socket.id);
        if (!pendingAdmission || pendingAdmission.canceled) {
            pendingAdmission?.release();
            socket.disconnect(true);
            return;
        }

        log({
            module: 'websocket',
            connectionType: clientType || 'user-scoped',
            clientType: labels.client,
        }, 'Socket authenticated');

        // Build the immutable capability from the server-authorized values.
        let connection: ClientConnection;
        if (clientType === 'session-scoped' && sessionId && authorizationGeneration !== undefined) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId,
                authorizationGeneration,
                accountAuthorizationGeneration,
                isAuthorizationCurrent: async () => (
                    await auth.isAuthorizationGenerationCurrent(userId, accountAuthorizationGeneration)
                    && await getSessionAuthorizationGeneration(userId, sessionId) === authorizationGeneration
                ),
                rpcRegistrationAuthorized: socket.data.rpcRegistrationAuthorized === true
            };
        } else if (clientType === 'machine-scoped' && machineId && authorizationGeneration !== undefined) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId,
                authorizationGeneration,
                accountAuthorizationGeneration,
                isAuthorizationCurrent: async () => (
                    await auth.isAuthorizationGenerationCurrent(userId, accountAuthorizationGeneration)
                    && await getMachineAuthorizationGeneration(userId, machineId) === authorizationGeneration
                ),
                rpcRegistrationAuthorized: socket.data.rpcRegistrationAuthorized === true
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId,
                accountAuthorizationGeneration,
                isAuthorizationCurrent: async () => auth.isAuthorizationGenerationCurrent(
                    userId,
                    accountAuthorizationGeneration,
                ),
            };
        }
        eventRouter.addConnection(userId, connection);
        if (!pendingAdmission.promote()) {
            socket.disconnect(true);
            return;
        }
        websocketConnectionsGauge.inc({ type: connection.connectionType, ...labels });

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(connection.machineId, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        // Track subsequent app focus changes for push notification routing.
        // The initial value was normalized into socket.data by middleware.
        onAuthorizedSocketEvent(socket, connection, 'app-state', (data: { state: string }) => {
            socket.data.appState = data?.state === 'active' ? 'active' : 'background';
        });

        socket.on('disconnect', () => {
            websocketEventsCounter.inc({ event_type: 'disconnect', ...labels });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            websocketConnectionsGauge.dec({ type: connection.connectionType, ...labels });

            log({ module: 'websocket', connectionType: connection.connectionType }, 'Socket disconnected');

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineActivity = buildMachineActivityEphemeral(connection.machineId, false, Date.now());
                eventRouter.emitEphemeral({
                    userId,
                    payload: machineActivity,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        });

        // Handlers
        rpcHandler(userId, socket, io, connection);
        usageHandler(userId, socket, connection);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket, connection);
        machineUpdateHandler(userId, socket, connection);

        // Ready
        log({ module: 'websocket', connectionType: connection.connectionType }, 'Socket connected');
    });

    onShutdown('api', async () => {
        await io.close();
    });
}
