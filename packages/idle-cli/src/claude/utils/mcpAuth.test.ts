import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createMcpCapabilityFile,
    readMcpCapabilityFile,
} from './mcpAuth';

describe('MCP capability files', () => {
    let root = '';

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'idle-mcp-auth-'));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('round-trips a random owner-only capability and removes it during cleanup', async () => {
        const capability = createMcpCapabilityFile(root);

        expect(readMcpCapabilityFile(capability.tokenFilePath)).toBe(capability.authToken);
        expect(capability.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        capability.cleanup();
        expect(() => readMcpCapabilityFile(capability.tokenFilePath)).toThrow();
    });

    it('refuses symlinks and files readable by other users', async () => {
        const readablePath = join(root, 'readable-token');
        const symlinkPath = join(root, 'linked-token');
        await writeFile(readablePath, 'a'.repeat(43), { mode: 0o644 });
        await chmod(readablePath, 0o644);
        await symlink(readablePath, symlinkPath);

        expect(() => readMcpCapabilityFile(readablePath)).toThrow(/permissions/i);
        expect(() => readMcpCapabilityFile(symlinkPath)).toThrow(/regular file|symbolic link/i);
    });
});
