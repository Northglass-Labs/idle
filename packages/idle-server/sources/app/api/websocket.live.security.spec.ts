import { io, Socket } from 'socket.io-client';
import { getExplicitLiveTestTarget } from '../../testing/liveTestTarget';

const LIVE_TARGET = getExplicitLiveTestTarget();
const WS_URL = LIVE_TARGET ?? 'http://127.0.0.1:1';
const describeLive = LIVE_TARGET ? describe : describe.skip;
const SOCKET_PATH = '/v1/updates';

/**
 * WebSocket security tests — verifies the server rejects unauthenticated
 * or improperly authenticated Socket.IO connections.
 *
 * The server's auth flow runs in Socket.IO namespace middleware before the
 * application connection callback. Invalid credentials therefore normally
 * produce connect_error; disconnect remains an acceptable transport-level
 * rejection for compatibility with older live targets.
 */
describeLive('WebSocket security', () => {
    let socket: Socket;

    beforeAll(async () => {
        const response = await fetch(WS_URL, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Explicit live-test target health check failed: ${response.status}`);
    });

    afterEach(() => {
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
        }
    });

    it('rejects connection without auth token', async () => {
        return new Promise<void>((resolve, reject) => {
            socket = io(WS_URL, {
                path: SOCKET_PATH,
                transports: ['websocket'],
                autoConnect: false,
                timeout: 10000,
            });

            const timer = setTimeout(() => {
                socket.disconnect();
                reject(new Error('Timed out — server did not reject or disconnect'));
            }, 15000);

            // Server emits 'error' with message before disconnecting
            socket.on('error', (data: { message: string }) => {
                clearTimeout(timer);
                expect(data.message).toBe('Missing authentication token');
                socket.disconnect();
                resolve();
            });

            // Fallback: server may disconnect before error event arrives
            socket.on('disconnect', (reason: string) => {
                clearTimeout(timer);
                // "io server disconnect" means the server forcefully closed the connection
                if (reason === 'io server disconnect') {
                    resolve();
                }
            });

            socket.on('connect_error', (err: Error) => {
                // If CORS or transport-level rejection happens, that's also a valid rejection
                clearTimeout(timer);
                socket.disconnect();
                resolve();
            });

            socket.connect();
        });
    }, 20000);

    it('rejects connection with invalid auth token', async () => {
        return new Promise<void>((resolve, reject) => {
            socket = io(WS_URL, {
                path: SOCKET_PATH,
                transports: ['websocket'],
                autoConnect: false,
                timeout: 10000,
                auth: {
                    token: 'fake-token-that-should-not-work-' + Date.now(),
                },
            });

            const timer = setTimeout(() => {
                socket.disconnect();
                reject(new Error('Timed out — server did not reject or disconnect'));
            }, 15000);

            socket.on('error', (data: { message: string }) => {
                clearTimeout(timer);
                expect(data.message).toBe('Invalid authentication token');
                socket.disconnect();
                resolve();
            });

            socket.on('disconnect', (reason: string) => {
                clearTimeout(timer);
                if (reason === 'io server disconnect') {
                    resolve();
                }
            });

            socket.on('connect_error', (err: Error) => {
                clearTimeout(timer);
                socket.disconnect();
                resolve();
            });

            socket.connect();
        });
    }, 20000);

    it('rejects connection with empty auth token', async () => {
        return new Promise<void>((resolve, reject) => {
            socket = io(WS_URL, {
                path: SOCKET_PATH,
                transports: ['websocket'],
                autoConnect: false,
                timeout: 10000,
                auth: {
                    token: '',
                },
            });

            const timer = setTimeout(() => {
                socket.disconnect();
                reject(new Error('Timed out — server did not reject or disconnect'));
            }, 15000);

            // Empty string is falsy, so server treats it as missing
            socket.on('error', (data: { message: string }) => {
                clearTimeout(timer);
                expect(data.message).toBe('Missing authentication token');
                socket.disconnect();
                resolve();
            });

            socket.on('disconnect', (reason: string) => {
                clearTimeout(timer);
                if (reason === 'io server disconnect') {
                    resolve();
                }
            });

            socket.on('connect_error', (err: Error) => {
                clearTimeout(timer);
                socket.disconnect();
                resolve();
            });

            socket.connect();
        });
    }, 20000);
});
