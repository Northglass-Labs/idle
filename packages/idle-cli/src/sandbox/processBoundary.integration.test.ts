import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { initializeSandbox, prepareSandboxedSpawn } from './manager';

async function runSpawn(command: string, args: string[]): Promise<{ status: number | null; output: string }> {
    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { output += String(chunk); });
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, output }));
    });
}

describe('sandboxed provider process boundary', () => {
    it.skipIf(process.platform === 'win32')(
        'preserves argv and enforces automatic read, egress, and bind restrictions on the real runtime',
        async () => {
            const sessionPath = mkdtempSync(join(tmpdir(), 'idle-sandbox-process-'));
            const controlledSecretPath = join(sessionPath, 'controlled-secret.txt');
            const shellInjectionMarker = join(sessionPath, 'argv-was-executed');
            writeFileSync(controlledSecretPath, 'controlled-secret');

            const secureDefaults = SandboxConfigSchema.parse({});
            const sandboxConfig = SandboxConfigSchema.parse({
                ...secureDefaults,
                workspaceRoot: sessionPath,
                sessionIsolation: 'strict',
                denyReadPaths: [...secureDefaults.denyReadPaths, controlledSecretPath],
                extraWritePaths: [sessionPath],
                denyWritePaths: [],
            });

            let controlledRequests = 0;
            const controlledServer = createServer((_request, response) => {
                controlledRequests += 1;
                response.end('controlled-endpoint');
            });
            await new Promise<void>((resolve, reject) => {
                controlledServer.once('error', reject);
                controlledServer.listen(0, '127.0.0.1', resolve);
            });
            const address = controlledServer.address();
            if (!address || typeof address === 'string') {
                throw new Error('Controlled endpoint did not bind to TCP');
            }

            const cleanup = await initializeSandbox(sandboxConfig, sessionPath);
            try {
                const wrapSpawn = await prepareSandboxedSpawn();
                const shellLikeArgument = `$(touch ${shellInjectionMarker})`;
                const printfSpawn = wrapSpawn('/usr/bin/printf', ['%s', shellLikeArgument]);
                const printfResult = spawnSync(printfSpawn.command, printfSpawn.args, {
                    encoding: 'utf8',
                });

                expect(printfResult.status).toBe(0);
                expect(printfResult.stdout).toBe(shellLikeArgument);
                expect(existsSync(shellInjectionMarker)).toBe(false);

                const readSpawn = wrapSpawn('/bin/cat', [controlledSecretPath]);
                const readResult = spawnSync(readSpawn.command, readSpawn.args, {
                    encoding: 'utf8',
                });

                expect(readResult.status).not.toBe(0);
                expect(readResult.stdout).not.toContain('controlled-secret');

                const networkScript = [
                    "const http = require('node:http')",
                    `http.get('http://127.0.0.1:${address.port}', (response) => {`,
                    "  response.resume(); response.on('end', () => process.exit(0))",
                    '}).on(\'error\', () => process.exit(17))',
                    'setTimeout(() => process.exit(18), 3000)',
                ].join(';');
                const networkSpawn = wrapSpawn(process.execPath, ['-e', networkScript]);
                const networkResult = await runSpawn(networkSpawn.command, networkSpawn.args);
                expect(networkResult.status).not.toBe(0);
                expect(networkResult.output).not.toContain('controlled-endpoint');
                expect(controlledRequests).toBe(0);

                const bindScript = [
                    "const net = require('node:net')",
                    "const server = net.createServer()",
                    "server.once('error', () => process.exit(19))",
                    "server.listen(0, '127.0.0.1', () => process.exit(0))",
                    'setTimeout(() => process.exit(20), 3000)',
                ].join(';');
                const bindSpawn = wrapSpawn(process.execPath, ['-e', bindScript]);
                const bindResult = await runSpawn(bindSpawn.command, bindSpawn.args);
                expect(bindResult.status).not.toBe(0);
            } finally {
                await cleanup();
                await new Promise<void>((resolve) => controlledServer.close(() => resolve()));
                rmSync(sessionPath, { recursive: true, force: true });
            }
        },
        60_000,
    );
});
