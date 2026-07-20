/**
 * Idle MCP server
 * Provides Idle CLI specific tools including chat session title management.
 * Includes auto-title fallback: if Claude doesn't call `change_title` within
 * 30 seconds of the first assistant response, a title is generated from the
 * working directory basename and the first user message.
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { basename } from "node:path";
import { z } from "zod";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { createMcpCapabilityFile } from "./mcpAuth";

/** How long (ms) to wait after the first assistant response before generating a fallback title */
const AUTO_TITLE_DELAY_MS = 30_000;

/** Maximum character length for the user-message portion of a fallback title */
const AUTO_TITLE_MESSAGE_MAX_LENGTH = 50;

/** Hard protocol boundary for user- and model-supplied session titles. */
const TITLE_MAX_LENGTH = 100;

/** MCP requests contain one tiny JSON-RPC envelope; larger bodies are abuse. */
const MAX_MCP_REQUEST_BYTES = 256 * 1024;

const BODY_REJECTED = Symbol('body-rejected');

async function readBoundedMcpBody(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<unknown | typeof BODY_REJECTED> {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BYTES) {
        res.writeHead(413, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
        res.end('{"error":"payload too large"}');
        req.resume();
        return BODY_REJECTED;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > MAX_MCP_REQUEST_BYTES) {
            res.writeHead(413, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
            res.end('{"error":"payload too large"}');
            return BODY_REJECTED;
        }
        chunks.push(buffer);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        res.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
        res.end('{"error":"invalid JSON"}');
        return BODY_REJECTED;
    }
}

const titleSchema = z
    .string()
    .trim()
    .min(1, 'Title must not be blank')
    .max(TITLE_MAX_LENGTH, `Title must be at most ${TITLE_MAX_LENGTH} characters`)
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'Title must be a single line without control characters');

function createMcpServer(handler: (title: string) => Promise<{ success: boolean }>, onTitleSet: () => void): McpServer {
    const mcp = new McpServer({
        name: "Idle MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Set or update the chat session title. Titles should be short (under 50 chars) and action-oriented, e.g. "Fix auth token refresh".',
        title: 'Change Chat Title',
        inputSchema: {
            title: titleSchema.describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handler(args.title);

        if (response.success) {
            onTitleSet();
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Chat title updated.',
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Unable to update the chat title.',
                    },
                ],
                isError: true,
            };
        }
    });

    return mcp;
}

export async function startIdleServer(client: ApiSessionClient) {
    logger.debug('[idleMCP] server:start');

    const capability = createMcpCapabilityFile(configuration.idleHomeDir);

    // Tracks whether Claude has already set a title via the change_title tool.
    // When true the auto-title fallback is skipped.
    let titleWasSet = false;

    // Reference to the pending auto-title timer so it can be cancelled on cleanup
    let autoTitleTimer: ReturnType<typeof setTimeout> | null = null;

    // Handler that sends title updates directly via metadata.
    // Title is session metadata, not a chat message — routing through
    // sendClaudeSessionMessage caused the protocol mapper to produce
    // empty envelopes (summary messages are intentionally dropped),
    // which could trigger HTTP 500 from downstream endpoints.
    const handler = async (title: string) => {
        try {
            await client.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: title,
                    updatedAt: Date.now()
                }
            }));
            logger.debug('[idleMCP] Title updated successfully');

            return { success: true };
        } catch {
            logger.debug('[idleMCP] Title update failed');
            return { success: false };
        }
    };

    const onTitleSet = () => {
        titleWasSet = true;
    };

    let stopped = false;
    const server = createServer({
        headersTimeout: 5_000,
        requestTimeout: 10_000,
        keepAliveTimeout: 1_000,
        maxHeaderSize: 16 * 1024,
    }, async (req, res) => {
        if (stopped || !hasValidAuthorization(req.headers.authorization, capability.authToken)) {
            res.writeHead(401, {
                'Cache-Control': 'no-store',
                'Content-Type': 'application/json',
                'WWW-Authenticate': 'Bearer',
            });
            res.end('{"error":"unauthorized"}');
            return;
        }

        res.setHeader('Cache-Control', 'no-store');
        const parsedBody = req.method === 'POST'
            ? await readBoundedMcpBody(req, res)
            : undefined;
        if (parsedBody === BODY_REJECTED) return;

        const mcp = createMcpServer(handler, onTitleSet);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            res.once('close', () => {
                void transport.close();
                void mcp.close();
            });
            await transport.handleRequest(req, res, parsedBody);
        } catch {
            logger.debug('[idleMCP] Request handling failed');
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            void mcp.close();
        }
    });
    server.maxConnections = 64;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 16;

    let baseUrl: URL;
    try {
        baseUrl = await new Promise<URL>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once('error', onError);
            server.listen(0, "127.0.0.1", () => {
                server.off('error', onError);
                const addr = server.address() as AddressInfo;
                resolve(new URL(`http://127.0.0.1:${addr.port}`));
            });
        });
    } catch (error) {
        try {
            capability.cleanup();
        } catch {
            logger.debug('[idleMCP] Capability cleanup failed after startup error');
        }
        throw error;
    }

    logger.debug('[idleMCP] server:ready');

    /**
     * Schedule a fallback title to be generated after AUTO_TITLE_DELAY_MS.
     * Call this once after the first assistant response arrives.
     * If Claude calls `change_title` before the timer fires, the fallback
     * is skipped. Safe to call multiple times — only the first call sets the timer.
     *
     * @param cwd - Working directory (used to derive the directory name portion)
     * @param firstUserMessage - Optional first user message to include in the title
     */
    function scheduleAutoTitle(cwd: string, firstUserMessage?: string): void {
        // Only schedule once
        if (autoTitleTimer) return;

        logger.debug(`[idleMCP] Scheduling auto-title fallback in ${AUTO_TITLE_DELAY_MS}ms`);

        autoTitleTimer = setTimeout(() => {
            autoTitleTimer = null;

            if (titleWasSet) {
                logger.debug('[idleMCP] Auto-title skipped — title already set by change_title tool');
                return;
            }

            const dirName = basename(cwd) || 'Session';
            let fallbackTitle = dirName;

            if (firstUserMessage) {
                const trimmed = firstUserMessage.trim();
                const truncated = trimmed.length > AUTO_TITLE_MESSAGE_MAX_LENGTH
                    ? trimmed.slice(0, AUTO_TITLE_MESSAGE_MAX_LENGTH - 1) + '\u2026'
                    : trimmed;
                fallbackTitle = `${dirName}: ${truncated}`;
            }

            const normalizedTitle = normalizeFallbackTitle(fallbackTitle);
            logger.debug('[idleMCP] Auto-title fallback fired');
            void handler(normalizedTitle);
        }, AUTO_TITLE_DELAY_MS);
    }

    return {
        url: baseUrl.toString(),
        tokenFilePath: capability.tokenFilePath,
        toolNames: ['change_title'],
        scheduleAutoTitle,
        stop: () => {
            if (stopped) return;
            stopped = true;
            logger.debug('[idleMCP] server:stop');
            if (autoTitleTimer) {
                clearTimeout(autoTitleTimer);
                autoTitleTimer = null;
            }
            server.close();
            try {
                capability.cleanup();
            } catch {
                logger.debug('[idleMCP] Capability cleanup failed');
            }
        }
    }
}

function hasValidAuthorization(authorization: string | undefined, authToken: string): boolean {
    if (!authorization) return false;
    const actual = Buffer.from(authorization, 'utf8');
    const expected = Buffer.from(`Bearer ${authToken}`, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeFallbackTitle(title: string): string {
    const singleLine = title
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const nonEmptyTitle = singleLine || 'Session';
    if (nonEmptyTitle.length <= TITLE_MAX_LENGTH) return nonEmptyTitle;
    return `${nonEmptyTitle.slice(0, TITLE_MAX_LENGTH - 1)}\u2026`;
}
