import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { Server } from 'socket.io';
import { Adapter, type BroadcastOptions } from 'socket.io-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eventRouter, type ClientConnection } from './eventRouter';

const ACCOUNT_ID = 'revocation-account';
const SOCKET_PATH = '/revocation-test';

/**
 * Minimal two-node adapter transport for exercising Socket.IO's documented
 * cluster-wide disconnect contract without depending on a Redis process in
 * the test environment. Local room membership and disconnect behavior still
 * come from Socket.IO's production in-memory Adapter implementation.
 */
class TestClusterBus {
    readonly adapters = new Set<TestClusterAdapter>();
    disconnectRequests = 0;
    completedDisconnectRequests = 0;

    createAdapter(namespace: ConstructorParameters<typeof Adapter>[0]): Adapter {
        return new TestClusterAdapter(namespace, this);
    }

    async disconnectSockets(options: BroadcastOptions, close: boolean): Promise<void> {
        this.disconnectRequests += 1;
        // Model the asynchronous publish performed by a cluster adapter. The
        // application must not report revocation complete before this settles.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        for (const adapter of this.adapters) {
            Adapter.prototype.disconnectSockets.call(adapter, options, close);
        }
        this.completedDisconnectRequests += 1;
    }
}

class TestClusterAdapter extends Adapter {
    constructor(namespace: ConstructorParameters<typeof Adapter>[0], private readonly bus: TestClusterBus) {
        super(namespace);
        bus.adapters.add(this);
    }

    override async disconnectSockets(options: BroadcastOptions, close: boolean): Promise<void> {
        await this.bus.disconnectSockets(options, close);
    }

    override close(): void {
        this.bus.adapters.delete(this);
    }
}

function waitForDisconnect(socket: ClientSocket): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for targeted disconnect')), 5_000);
        socket.once('disconnect', (reason) => {
            clearTimeout(timer);
            resolve(reason);
        });
    });
}

describe('eventRouter targeted revocation with real Socket.IO rooms', () => {
    let httpServer: HttpServer;
    let io: Server;
    let origin: string;
    let cluster: TestClusterBus;
    const replicaServers: Server[] = [];
    const clients: ClientSocket[] = [];

    // Socket.IO invokes adapter factories with `new`, so this intentionally
    // remains a constructable function rather than an arrow function.
    function createClusterAdapter(namespace: ConstructorParameters<typeof Adapter>[0]): Adapter {
        return cluster.createAdapter(namespace);
    }

    beforeEach(async () => {
        cluster = new TestClusterBus();
        httpServer = createServer();
        io = new Server(httpServer, {
            path: SOCKET_PATH,
            adapter: createClusterAdapter,
        });
        eventRouter.init(io);

        registerConnectionHandler(io);

        await listen(httpServer);
        const address = httpServer.address() as AddressInfo;
        origin = `http://127.0.0.1:${address.port}`;
    });

    function registerConnectionHandler(server: Server): void {
        server.on('connection', (socket) => {
            const { scope, objectId } = socket.handshake.auth as {
                scope?: unknown;
                objectId?: unknown;
            };
            let connection: ClientConnection;
            if (scope === 'session' && typeof objectId === 'string') {
                connection = {
                    connectionType: 'session-scoped',
                    socket,
                    userId: ACCOUNT_ID,
                    sessionId: objectId,
                    authorizationGeneration: 1,
                    accountAuthorizationGeneration: 1,
                    isAuthorizationCurrent: async () => true,
                };
                socket.join(`rpc:${ACCOUNT_ID}:${objectId}:bash`);
            } else if (scope === 'machine' && typeof objectId === 'string') {
                connection = {
                    connectionType: 'machine-scoped',
                    socket,
                    userId: ACCOUNT_ID,
                    machineId: objectId,
                    authorizationGeneration: 1,
                    accountAuthorizationGeneration: 1,
                    isAuthorizationCurrent: async () => true,
                };
                socket.join(`rpc:${ACCOUNT_ID}:${objectId}:bash`);
            } else {
                connection = {
                    connectionType: 'user-scoped',
                    socket,
                    userId: ACCOUNT_ID,
                    accountAuthorizationGeneration: 1,
                    isAuthorizationCurrent: async () => true,
                };
            }
            eventRouter.addConnection(ACCOUNT_ID, connection);
            socket.emit('test-ready');
        });
    }

    async function listen(server: HttpServer): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    }

    afterEach(async () => {
        for (const client of clients) {
            client.removeAllListeners();
            client.close();
        }
        clients.length = 0;
        for (const replica of replicaServers) {
            await new Promise<void>((resolve) => replica.close(() => resolve()));
        }
        replicaServers.length = 0;
        if (io) {
            await new Promise<void>((resolve) => io.close(() => resolve()));
        }
    });

    async function connect(
        scope: 'user' | 'session' | 'machine',
        objectId?: string,
        targetOrigin = origin,
    ): Promise<ClientSocket> {
        const client = createClient(targetOrigin, {
            path: SOCKET_PATH,
            transports: ['websocket'],
            reconnection: false,
            autoConnect: false,
            auth: { scope, objectId },
        });
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out connecting test socket')), 5_000);
            client.once('test-ready', () => {
                clearTimeout(timer);
                resolve();
            });
            client.once('connect_error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            client.connect();
        });
        return client;
    }

    it('removes the selected object and its RPC rooms while preserving sibling capabilities', async () => {
        const selectedSession = await connect('session', 'session-selected');
        const siblingSession = await connect('session', 'session-sibling');
        const selectedMachine = await connect('machine', 'machine-selected');
        const siblingMachine = await connect('machine', 'machine-sibling');
        const user = await connect('user');

        const sessionDisconnect = waitForDisconnect(selectedSession);
        await eventRouter.disconnectSessionConnections(ACCOUNT_ID, 'session-selected');
        expect(cluster.completedDisconnectRequests).toBe(1);
        expect(await sessionDisconnect).toBe('io server disconnect');
        expect((await io.in(`user:${ACCOUNT_ID}:session:session-selected`).fetchSockets())).toHaveLength(0);
        expect((await io.in(`rpc:${ACCOUNT_ID}:session-selected:bash`).fetchSockets())).toHaveLength(0);
        expect(siblingSession.connected).toBe(true);
        expect(selectedMachine.connected).toBe(true);
        expect(siblingMachine.connected).toBe(true);
        expect(user.connected).toBe(true);

        const machineDisconnect = waitForDisconnect(selectedMachine);
        await eventRouter.disconnectMachineConnections(ACCOUNT_ID, 'machine-selected');
        expect(cluster.completedDisconnectRequests).toBe(2);
        expect(await machineDisconnect).toBe('io server disconnect');
        expect((await io.in(`user:${ACCOUNT_ID}:machine:machine-selected`).fetchSockets())).toHaveLength(0);
        expect((await io.in(`rpc:${ACCOUNT_ID}:machine-selected:bash`).fetchSockets())).toHaveLength(0);
        expect(siblingSession.connected).toBe(true);
        expect(siblingMachine.connected).toBe(true);
        expect(user.connected).toBe(true);
    });

    it('propagates exact session and machine revocation to a second relay', async () => {
        const replicaHttpServer = createServer();
        const replicaIo = new Server(replicaHttpServer, {
            path: SOCKET_PATH,
            adapter: createClusterAdapter,
        });
        replicaServers.push(replicaIo);
        registerConnectionHandler(replicaIo);
        await listen(replicaHttpServer);
        const replicaAddress = replicaHttpServer.address() as AddressInfo;
        const replicaOrigin = `http://127.0.0.1:${replicaAddress.port}`;

        const selectedSession = await connect('session', 'session-selected-remote', replicaOrigin);
        const siblingSession = await connect('session', 'session-sibling-remote', replicaOrigin);
        const selectedMachine = await connect('machine', 'machine-selected-remote', replicaOrigin);
        const siblingMachine = await connect('machine', 'machine-sibling-remote', replicaOrigin);
        const localUser = await connect('user');

        const sessionDisconnect = waitForDisconnect(selectedSession);
        await eventRouter.disconnectSessionConnections(ACCOUNT_ID, 'session-selected-remote');
        expect(cluster.completedDisconnectRequests).toBe(1);
        expect(await sessionDisconnect).toBe('io server disconnect');
        expect((await replicaIo.in(`user:${ACCOUNT_ID}:session:session-selected-remote`).fetchSockets())).toHaveLength(0);
        expect((await replicaIo.in(`rpc:${ACCOUNT_ID}:session-selected-remote:bash`).fetchSockets())).toHaveLength(0);
        expect(siblingSession.connected).toBe(true);
        expect(selectedMachine.connected).toBe(true);
        expect(siblingMachine.connected).toBe(true);
        expect(localUser.connected).toBe(true);

        const machineDisconnect = waitForDisconnect(selectedMachine);
        await eventRouter.disconnectMachineConnections(ACCOUNT_ID, 'machine-selected-remote');
        expect(cluster.completedDisconnectRequests).toBe(2);
        expect(await machineDisconnect).toBe('io server disconnect');
        expect((await replicaIo.in(`user:${ACCOUNT_ID}:machine:machine-selected-remote`).fetchSockets())).toHaveLength(0);
        expect((await replicaIo.in(`rpc:${ACCOUNT_ID}:machine-selected-remote:bash`).fetchSockets())).toHaveLength(0);
        expect(siblingSession.connected).toBe(true);
        expect(siblingMachine.connected).toBe(true);
        expect(localUser.connected).toBe(true);
        expect(cluster.disconnectRequests).toBe(2);
    });
});
