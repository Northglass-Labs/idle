import { describe, expect, it, vi } from 'vitest';

vi.mock('@/projectPath', () => ({
    projectPath: () => '/opt/idle',
}));

import { createIdleMcpBridgeConfig } from './createIdleMcpBridgeConfig';

describe('createIdleMcpBridgeConfig', () => {
    it('passes only an owner-only capability path to the bridge configuration', () => {
        const tokenFilePath = '/private/idle/session.token';
        const config = createIdleMcpBridgeConfig({
            tokenFilePath,
            url: 'http://127.0.0.1:4242/',
        });
        const serialized = JSON.stringify(config);

        expect(config.command).toBe(process.execPath);
        expect(config.args).toContain('/opt/idle/bin/idle-mcp.mjs');
        expect(config.env.IDLE_HTTP_MCP_TOKEN_FILE).toBe(tokenFilePath);
        expect(config.env.NO_PROXY.split(',')).toEqual(expect.arrayContaining([
            '127.0.0.1',
            'localhost',
            '::1',
        ]));
        expect(config.env.no_proxy).toBe(config.env.NO_PROXY);
        expect(serialized).not.toMatch(/Bearer /);
    });
});
