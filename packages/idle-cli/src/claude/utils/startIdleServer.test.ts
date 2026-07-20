import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';

const mocked = vi.hoisted(() => ({ idleHomeDir: '' }));

vi.mock('@/configuration', () => ({
    configuration: {
        get idleHomeDir() {
            return mocked.idleHomeDir;
        },
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

import { startIdleServer } from './startIdleServer';
import { createIdleMcpBridgeConfig } from './createIdleMcpBridgeConfig';

type IdleServer = Awaited<ReturnType<typeof startIdleServer>>;

const servers: IdleServer[] = [];

function tokenFilePath(server: IdleServer): string {
    return (server as IdleServer & { tokenFilePath: string }).tokenFilePath;
}

function createSessionClient(onMetadata: (metadata: unknown) => void): ApiSessionClient {
    return {
        sessionId: 'test-session',
        updateMetadata: vi.fn(async (updater: (metadata: Record<string, unknown>) => unknown) => {
            onMetadata(updater({}));
        }),
    } as unknown as ApiSessionClient;
}

async function start(onMetadata = vi.fn()) {
    const server = await startIdleServer(createSessionClient(onMetadata));
    servers.push(server);
    return { onMetadata, server };
}

async function connect(server: IdleServer): Promise<Client> {
    const token = await readFile(tokenFilePath(server), 'utf8');
    const client = new Client(
        { name: 'idle-mcp-security-test', version: '1.0.0' },
        { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
            headers: { Authorization: `Bearer ${token}` },
        },
    });
    await client.connect(transport);
    return client;
}

describe('startIdleServer', () => {
    beforeEach(async () => {
        mocked.idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-mcp-server-'));
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            server.stop();
        }
        await rm(mocked.idleHomeDir, { recursive: true, force: true });
    });

    it('rejects unauthenticated loopback requests before MCP processing', async () => {
        const { onMetadata, server } = await start();

        const response = await fetch(server.url, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'change_title', arguments: { title: 'Injected title' } },
            }),
        });

        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');

        const wrongCapability = await fetch(server.url, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${'a'.repeat(43)}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });

        expect(wrongCapability.status).toBe(401);
        expect(onMetadata).not.toHaveBeenCalled();
    });

    it('rejects oversized authenticated chunked requests before MCP processing', async () => {
        const { onMetadata, server } = await start();
        const token = await readFile(tokenFilePath(server), 'utf8');
        const target = new URL(server.url);

        const status = await new Promise<number>((resolve, reject) => {
            const req = request({
                host: target.hostname,
                port: Number(target.port),
                method: 'POST',
                path: '/',
                headers: {
                    Accept: 'application/json, text/event-stream',
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }, (response) => {
                response.resume();
                response.once('end', () => resolve(response.statusCode ?? 0));
            });
            req.once('error', reject);
            req.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"change_title","arguments":{"title":"');
            req.write('x'.repeat(300 * 1024));
            req.end('"}}}');
        });

        expect(status).toBe(413);
        expect(onMetadata).not.toHaveBeenCalled();
    });

    it('stores the capability in an owner-only file and accepts legitimate title changes', async () => {
        const { onMetadata, server } = await start();
        const path = tokenFilePath(server);

        expect((await stat(join(mocked.idleHomeDir, 'tmp', 'mcp'))).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(server.url).not.toContain(await readFile(path, 'utf8'));

        const client = await connect(server);
        const response = await client.callTool({
            name: 'change_title',
            arguments: { title: '  Fix authenticated MCP  ' },
        });

        expect(response.isError).toBe(false);
        expect(onMetadata).toHaveBeenCalledWith(expect.objectContaining({
            summary: expect.objectContaining({ text: 'Fix authenticated MCP' }),
        }));

        await client.close();
        server.stop();
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects blank and oversized titles without mutating metadata', async () => {
        const { onMetadata, server } = await start();
        const client = await connect(server);

        const blank = await client.callTool({
            name: 'change_title',
            arguments: { title: '   ' },
        });
        const oversized = await client.callTool({
            name: 'change_title',
            arguments: { title: 'x'.repeat(101) },
        });

        expect(blank.isError).toBe(true);
        expect(oversized.isError).toBe(true);
        expect(onMetadata).not.toHaveBeenCalled();
        await client.close();
    });

    it('authenticates a packaged STDIO bridge without putting the token in its arguments', async () => {
        const { onMetadata, server } = await start();
        const config = createIdleMcpBridgeConfig(server);
        const transport = new StdioClientTransport({
            ...config,
            env: {
                ...getDefaultEnvironment(),
                ...config.env,
            },
            stderr: 'pipe',
        });
        const client = new Client(
            { name: 'idle-packaged-bridge-test', version: '1.0.0' },
            { capabilities: {} },
        );

        expect(JSON.stringify(config.args)).not.toContain(await readFile(tokenFilePath(server), 'utf8'));
        await client.connect(transport);
        const response = await client.callTool({
            name: 'change_title',
            arguments: { title: 'Packaged bridge works' },
        });

        expect(response.isError).toBe(false);
        expect(onMetadata).toHaveBeenCalledWith(expect.objectContaining({
            summary: expect.objectContaining({ text: 'Packaged bridge works' }),
        }));
        await client.close();
    });
});
