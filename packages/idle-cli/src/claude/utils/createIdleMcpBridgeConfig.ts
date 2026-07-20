import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { IDLE_HTTP_MCP_TOKEN_FILE_ENV } from './mcpAuth';
import { ensureLocalProxyBypass } from './proxyBypass';

export interface IdleMcpBridgeTarget {
    tokenFilePath: string;
    url: string;
}

export function createIdleMcpBridgeConfig(target: IdleMcpBridgeTarget) {
    const proxyBypassEnvironment: Record<string, string | undefined> = {
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy,
    };
    ensureLocalProxyBypass(proxyBypassEnvironment);
    const noProxy = proxyBypassEnvironment.NO_PROXY
        ?? proxyBypassEnvironment.no_proxy
        ?? '127.0.0.1,localhost,::1';

    return {
        command: process.execPath,
        args: [
            '--no-warnings',
            '--no-deprecation',
            join(projectPath(), 'bin', 'idle-mcp.mjs'),
            '--url',
            target.url,
        ],
        env: {
            [IDLE_HTTP_MCP_TOKEN_FILE_ENV]: target.tokenFilePath,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
        },
    };
}
