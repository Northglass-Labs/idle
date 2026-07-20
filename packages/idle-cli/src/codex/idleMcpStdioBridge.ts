/**
 * Idle MCP STDIO Bridge
 *
 * Minimal STDIO MCP server exposing a single tool `change_title`.
 * On invocation it forwards the tool call to an existing Idle HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `IDLE_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`. The owning Idle process must
 * also provide the path to an owner-only capability file.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import {
  IDLE_HTTP_MCP_TOKEN_FILE_ENV,
  readMcpCapabilityFile,
} from '@/claude/utils/mcpAuth';

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.IDLE_HTTP_MCP_URL || '';
  const tokenFilePath = process.env[IDLE_HTTP_MCP_TOKEN_FILE_ENV] || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[idle-mcp] Missing target URL. Set IDLE_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }
  if (!tokenFilePath) {
    process.stderr.write('[idle-mcp] Missing owner capability file\n');
    process.exit(2);
  }

  const targetUrl = parseLoopbackUrl(baseUrl);
  let authToken: string;
  try {
    authToken = readMcpCapabilityFile(tokenFilePath);
  } catch {
    throw new Error('Unable to read owner-only MCP capability');
  }

  let httpClient: Client | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    const client = new Client(
      { name: 'idle-stdio-bridge', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(targetUrl, {
      requestInit: {
        headers: { Authorization: `Bearer ${authToken}` },
      },
    });
    await client.connect(transport);
    httpClient = client;
    return client;
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Idle MCP Bridge',
    version: '1.0.0',
  });

  // Register the single tool and forward to HTTP MCP
  server.registerTool(
    'change_title',
    {
      description: 'Change the title of the current chat session',
      title: 'Change Chat Title',
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\u0000-\u001f\u007f]*$/)
          .describe('The new title for the chat session'),
      },
    },
    async (args) => {
      try {
        const client = await ensureHttpClient();
        const response = await client.callTool({ name: 'change_title', arguments: args });
        // Pass-through response from HTTP server
        return response as any;
      } catch {
        return {
          content: [
            { type: 'text', text: 'Unable to update the chat title.' },
          ],
          isError: true,
        };
      }
    }
  );

  // Start STDIO transport
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

function parseLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username
    || url.password
  ) {
    throw new Error('Idle MCP target must be an unauthenticated IPv4 loopback HTTP URL');
  }
  return url;
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[idle-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
