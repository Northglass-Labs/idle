/**
 * Dedicated HTTP server for receiving Claude session hooks
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook.
 *
 * Separate from the MCP server to keep concerns isolated.
 *
 * ## Control Flow
 *
 * ### Startup
 * ```
 * runClaude.ts
 *     │
 *     ├─► startHookServer() ──► HTTP server on random port (e.g., 52290)
 *     │
 *     ├─► generateHookSettingsFile(port) ──► ~/.idle/tmp/hooks/session-hook-<pid>.json
 *     │   (contains SessionStart hook pointing to our server)
 *     │
 *     └─► loop() ──► claudeLocal/claudeRemote
 *             │
 *             └─► spawn claude --settings <hook-settings-path>
 * ```
 *
 * ### Session Notification Flow
 * ```
 * Claude CLI (SessionStart event)
 *     │
 *     ├─► Reads hooks from --settings file
 *     │
 *     └─► Executes hook command (session_hook_forwarder.cjs)
 *             │
 *             ├─► Receives session data on stdin
 *             │
 *             └─► HTTP POST to http://127.0.0.1:<port>/hook/session-start
 *                     │
 *                     └─► startHookServer receives it
 *                             │
 *                             └─► onSessionHook(sessionId, data)
 *                                     │
 *                                     ├─► Updates Session.sessionId
 *                                     ├─► Updates API metadata
 *                                     └─► Notifies SessionScanner
 * ```
 *
 * ### Triggered By
 * - `idle` (fresh start) - new session created
 * - `idle --continue` - continues last session (may fork)
 * - `idle --resume` - interactive picker, then resume
 * - `idle --resume <id>` - resume specific session
 * - `/compact` command - compacts and forks session
 * - Double-escape fork - user forks conversation in CLI
 *
 * ### Why Not Use File Watching?
 * File watching has race conditions when multiple Idle processes run.
 * With hooks, Claude directly tells THIS specific process about its session,
 * ensuring 1:1 mapping between Idle process and Claude session.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';

const MAX_HOOK_BODY_BYTES = 64 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Per-process bearer token passed only to the owner-only hook forwarder. */
    authToken: string;
    /** Stop the server */
    stop: () => void;
}

function hasValidAuthorization(req: IncomingMessage, authToken: string): boolean {
    const presented = Buffer.from(req.headers.authorization ?? '', 'utf8');
    const expected = Buffer.from(`Bearer ${authToken}`, 'utf8');
    return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 *
 * @param options - Server options including the session hook callback
 * @returns Promise resolving to the server instance with port info
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook } = options;
    const authToken = randomBytes(32).toString('base64url');

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // Only handle POST to /hook/session-start
            if (req.method === 'POST' && req.url === '/hook/session-start') {
                if (!hasValidAuthorization(req, authToken)) {
                    res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized');
                    return;
                }

                if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
                    res.writeHead(415, { 'Content-Type': 'text/plain' }).end('unsupported media type');
                    return;
                }

                const declaredLength = Number(req.headers['content-length']);
                if (
                    Number.isFinite(declaredLength)
                    && declaredLength > MAX_HOOK_BODY_BYTES
                ) {
                    res.writeHead(413, { 'Content-Type': 'text/plain' }).end('payload too large');
                    return;
                }

                // Set timeout to prevent hanging if Claude doesn't close stdin
                let timedOut = false;
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        timedOut = true;
                        logger.debug('[hookServer] Request timeout');
                        res.writeHead(408, {
                            'Cache-Control': 'no-store',
                            'Content-Type': 'text/plain',
                            Connection: 'close',
                        }).end('timeout');
                    }
                }, 5000);

                try {
                    const chunks: Buffer[] = [];
                    let receivedBytes = 0;
                    for await (const chunk of req) {
                        if (timedOut) return;
                        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        receivedBytes += buffer.length;
                        if (receivedBytes > MAX_HOOK_BODY_BYTES) {
                            clearTimeout(timeout);
                            res.writeHead(413, { 'Content-Type': 'text/plain' }).end('payload too large');
                            return;
                        }
                        chunks.push(buffer);
                    }
                    clearTimeout(timeout);
                    if (timedOut) return;

                    const body = Buffer.concat(chunks).toString('utf-8');

                    let data: SessionHookData;
                    try {
                        const parsed: unknown = JSON.parse(body);
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            throw new Error('Hook payload must be a JSON object');
                        }
                        data = parsed as SessionHookData;
                    } catch {
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid JSON');
                        return;
                    }

                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = data.session_id || data.sessionId;
                    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
                        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid session ID');
                        return;
                    }

                    onSessionHook(sessionId, data);

                    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
                } catch {
                    clearTimeout(timeout);
                    logger.debug('[hookServer] Error handling session hook');
                    if (!res.headersSent) {
                        res.writeHead(500).end('error');
                    }
                }
                return;
            }

            // 404 for anything else
            res.writeHead(404).end('not found');
        });
        server.maxConnections = 16;
        server.maxHeadersCount = 32;
        server.headersTimeout = 5_000;
        server.requestTimeout = 6_000;
        server.keepAliveTimeout = 1_000;
        server.maxRequestsPerSocket = 4;

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug('[hookServer] Started');

            resolve({
                port,
                authToken,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error');
            reject(err);
        });
    });
}
