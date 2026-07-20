import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type DaemonLocallyPersistedState,
    readDaemonState,
    removeLegacySessionKeyCache,
    SandboxConfigSchema,
    parseSandboxConfigForSettings,
    writeDaemonState,
} from './persistence';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
    ));
});

describe('removeLegacySessionKeyCache', () => {
    it('removes the obsolete plaintext session-key cache without following a symlink', async () => {
        const idleHomeDir = await mkdtemp(join(tmpdir(), 'idle-key-cache-test-'));
        temporaryDirectories.push(idleHomeDir);
        const outsideFile = join(idleHomeDir, 'outside.json');
        const cacheFile = join(idleHomeDir, 'session-key-cache.json');

        await writeFile(outsideFile, 'outside-data', { mode: 0o600 });
        await writeFile(cacheFile, '{"entries":{"session":{"key":"plaintext"}}}', { mode: 0o600 });

        await expect(removeLegacySessionKeyCache(idleHomeDir)).resolves.toBe(true);
        await expect(readFile(cacheFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

        await symlink(outsideFile, cacheFile);
        await expect(removeLegacySessionKeyCache(idleHomeDir)).resolves.toBe(true);
        await expect(readFile(cacheFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside-data');
        await expect(removeLegacySessionKeyCache(idleHomeDir)).resolves.toBe(false);
    });
});

describe('daemon control state', () => {
    it('securely preserves the control token across repeated heartbeat rewrites', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'idle-daemon-state-test-'));
        temporaryDirectories.push(directory);
        const outsideFile = join(directory, 'outside.json');
        const stateFile = join(directory, 'daemon.state.json');
        const state: DaemonLocallyPersistedState = {
            pid: 123,
            httpPort: 4321,
            controlToken: 'a'.repeat(43),
            startTime: '2026-07-11T00:00:00.000Z',
            startedWithCliVersion: '1.2.3',
        };

        await writeFile(outsideFile, 'outside-data', { mode: 0o600 });
        let latestState = state;
        for (let heartbeat = 1; heartbeat <= 3; heartbeat += 1) {
            await rm(stateFile, { force: true });
            await symlink(outsideFile, stateFile);

            latestState = {
                ...state,
                lastHeartbeat: `2026-07-11T00:00:0${heartbeat}.000Z`,
            };
            writeDaemonState(latestState, stateFile);

            const stateStats = await lstat(stateFile);
            expect(stateStats.isFile()).toBe(true);
            expect(stateStats.isSymbolicLink()).toBe(false);
            expect(stateStats.mode & 0o777).toBe(0o600);
            expect(stateStats.nlink).toBe(1);
            if (typeof process.getuid === 'function') {
                expect(stateStats.uid).toBe(process.getuid());
            }
            await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside-data');
            await expect(readDaemonState(stateFile)).resolves.toEqual(latestState);
        }

        await chmod(stateFile, 0o644);
        await expect(readDaemonState(stateFile)).resolves.toEqual(latestState);
        expect((await lstat(stateFile)).mode & 0o777).toBe(0o600);
    });
});

describe('SandboxConfigSchema', () => {
    it('fails closed to enabled defaults when persisted sandbox policy is malformed', () => {
        expect(parseSandboxConfigForSettings({
            enabled: 'not-a-boolean',
            denyReadPaths: [],
        })).toMatchObject({
            policyVersion: 2,
            enabled: true,
            denyReadPaths: expect.arrayContaining([
                '~/.ssh',
                '~/.aws',
                '~/.gnupg',
                '~/.azure',
                '~/.kube',
                '~/.docker',
                '~/.netrc',
                '~/.npmrc',
                '~/.pypirc',
                '~/.config/gh',
                '~/.idle/access.key',
                '~/.idle/agent.key',
                '~/.idle/settings.json',
                '~/.idle/settings.json.lock',
                '~/.idle/daemon.state.json',
                '~/.idle/daemon.state.json.lock',
                '~/.idle/sessions.json',
            ]),
            networkMode: 'custom',
            allowedDomains: expect.arrayContaining([
                'api.anthropic.com',
                'api.openai.com',
                'generativelanguage.googleapis.com',
            ]),
            allowLocalBinding: false,
        });

        expect(parseSandboxConfigForSettings({ enabled: false })).toMatchObject({
            enabled: false,
        });
    });

    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        // Security hardening: default for `enabled` flipped from false → true
        // (sandbox enabled by default; users opt out via `idle sandbox
        // disable` or `--no-sandbox`).
        expect(parsed).toEqual({
            policyVersion: 2,
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [
                '~/.ssh',
                '~/.aws',
                '~/.gnupg',
                '~/.azure',
                '~/.kube',
                '~/.docker',
                '~/.netrc',
                '~/.npmrc',
                '~/.pypirc',
                '~/.config/gh',
                '~/.config/gcloud',
                '~/.config/op',
                '~/.config/1Password',
                '~/.password-store',
                '~/.local/share/keyrings',
                '~/Library/Group Containers/2BUA8C4S2C.com.1password',
                '~/Library/Application Support/Google/Chrome',
                '~/Library/Application Support/Chromium',
                '~/Library/Application Support/BraveSoftware',
                '~/Library/Application Support/Firefox/Profiles',
                '~/.mozilla',
                '~/.config/google-chrome',
                '~/.config/chromium',
                '~/.config/BraveSoftware',
                '~/.idle/access.key',
                '~/.idle/agent.key',
                '~/.idle/settings.json',
                '~/.idle/settings.json.lock',
                '~/.idle/daemon.state.json',
                '~/.idle/daemon.state.json.lock',
                '~/.idle/sessions.json',
                '~/.idle/rpc-replay-v1',
                '~/.idle/message-replay-v1',
                '~/.idle/.message-replay-v1.initialized',
            ],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'custom',
            allowedDomains: [
                'api.anthropic.com',
                '*.anthropic.com',
                'api.openai.com',
                '*.openai.com',
                'chatgpt.com',
                '*.chatgpt.com',
                'generativelanguage.googleapis.com',
                '*.googleapis.com',
            ],
            deniedDomains: [],
            allowLocalBinding: false,
        });
    });

    it('upgrades the legacy automatic allow-all policy but preserves an explicit current opt-in', () => {
        const legacyAutomatic = parseSandboxConfigForSettings({
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [
                '~/.ssh',
                '~/.aws',
                '~/.gnupg',
                '~/.idle/access.key',
                '~/.idle/agent.key',
                '~/.idle/settings.json',
                '~/.idle/settings.json.lock',
                '~/.idle/daemon.state.json',
                '~/.idle/daemon.state.json.lock',
                '~/.idle/sessions.json',
            ],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });

        expect(legacyAutomatic).toMatchObject({
            policyVersion: 2,
            networkMode: 'custom',
            allowLocalBinding: false,
        });
        expect(legacyAutomatic.denyReadPaths).toContain('~/.config/gh');
        expect(legacyAutomatic.allowedDomains).toContain('api.openai.com');

        expect(parseSandboxConfigForSettings({
            policyVersion: 2,
            enabled: true,
            networkMode: 'allowed',
            allowLocalBinding: true,
        })).toMatchObject({
            policyVersion: 2,
            networkMode: 'allowed',
            allowLocalBinding: true,
        });
    });

    it('secures every pre-v2 policy while preserving safe user additions and explicit disablement', () => {
        const migrated = parseSandboxConfigForSettings({
            policyVersion: 1,
            enabled: false,
            workspaceRoot: '~/Projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/Projects/idle'],
            denyReadPaths: ['~/.ssh', '~/.private-tool'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'allowed',
            allowedDomains: ['packages.example.invalid'],
            deniedDomains: ['tracking.example.invalid'],
            allowLocalBinding: true,
        });

        expect(migrated).toMatchObject({
            policyVersion: 2,
            enabled: false,
            workspaceRoot: '~/Projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/Projects/idle'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            deniedDomains: ['tracking.example.invalid'],
            allowLocalBinding: false,
        });
        expect(migrated.denyReadPaths).toEqual(expect.arrayContaining([
            '~/.config/gh',
            '~/.private-tool',
        ]));
        expect(migrated.allowedDomains).toEqual(expect.arrayContaining([
            'api.openai.com',
            'packages.example.invalid',
        ]));

        expect(parseSandboxConfigForSettings({
            enabled: true,
            networkMode: 'blocked',
            allowLocalBinding: true,
        })).toMatchObject({
            policyVersion: 2,
            networkMode: 'blocked',
            allowLocalBinding: false,
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            policyVersion: 2,
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});
