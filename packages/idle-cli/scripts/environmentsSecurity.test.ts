import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import tweetnacl from 'tweetnacl';
import { buildAuthChallengeMessage, encodeAuthPairingPayload } from '@northglass/idle-wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    authenticateSeedClient,
    assertTailscaleServeTargetsAvailable,
    atomicWritePrivateFile,
    buildClientEnvVars,
    buildEnvSh,
    buildServerEnvVars,
    buildTailscaleAccessConfig,
    captureProcessIdentity,
    ensureEnvironmentMasterSecret,
    ensurePrivateDirectory,
    getEnvironmentDir,
    getTailscaleServeCommands,
    mergeClientEnvironment,
    openPrivateAppendFile,
    parseEnvironmentConfigValue,
    parseManagedProcessState,
    promoteManagedProcessIdentityAfterReadiness,
    readBoundedFileNoFollow,
    verifyManagedProcessIdentity,
} from '../../../environments/environments';

const temporaryRoots: string[] = [];

const SERVER_ONLY_TEST_KEYS = [
    'IDLE_MASTER_SECRET',
    'IDLE_AUTH_AUDIENCE',
    'IDLE_ACCOUNT_REGISTRATION_MODE',
    'IDLE_MAX_ACCOUNTS',
    'IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES',
    'IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS',
    'DATABASE_URL',
    'DATA_DIR',
    'PGLITE_DIR',
    'DB_PROVIDER',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_AGENT_ID',
    'ELEVENLABS_MAX_CONVERSATION_SECONDS',
    'REVENUECAT_API_KEY',
    'REVENUECAT_PROJECT_ID',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'IDLE_ADMIN_SECRET',
    'REDIS_URL',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKET',
    'S3_HOST',
    'S3_PORT',
    'S3_PUBLIC_URL',
    'S3_REGION',
    'S3_USE_SSL',
    'METRICS_ENABLED',
    'METRICS_HOST',
    'METRICS_PORT',
    'IDLE_CORS_ORIGIN',
    'PUBLIC_URL',
    'IDLE_STATIC_DIR',
    'IDLE_INJECT_HTML_CONFIG',
    'HAPPY_STATIC_DIR',
    'HAPPY_INJECT_HTML_CONFIG',
] as const;

function syntheticServerEnvironment(): NodeJS.ProcessEnv {
    return Object.fromEntries(SERVER_ONLY_TEST_KEYS.map(key => [key, `synthetic-${key.toLowerCase()}`]));
}

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-env-security-'));
    temporaryRoots.push(root);
    fs.chmodSync(root, 0o700);
    return root;
}

function mode(filePath: string): number {
    return fs.statSync(filePath).mode & 0o777;
}

function encryptBoxBundle(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const ciphertext = tweetnacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
    const bundle = new Uint8Array(ephemeral.publicKey.length + nonce.length + ciphertext.length);
    bundle.set(ephemeral.publicKey, 0);
    bundle.set(nonce, ephemeral.publicKey.length);
    bundle.set(ciphertext, ephemeral.publicKey.length + nonce.length);
    return bundle;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('environment manager path boundary', () => {
    it('accepts generated environment names', () => {
        expect(getEnvironmentDir('clever-cedar')).toMatch(/\/clever-cedar$/);
    });

    it.each([
        '../outside',
        '../../outside',
        '/tmp/outside',
        'clever-cedar/../../outside',
        'clever cedar',
        '.hidden',
        '',
    ])('rejects an unsafe environment name: %j', (name) => {
        expect(() => getEnvironmentDir(name)).toThrow(/environment name/i);
    });

    it('rejects a symlinked managed-directory component', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const outside = path.join(root, 'outside');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        fs.mkdirSync(outside, { mode: 0o700 });
        fs.symlinkSync(outside, path.join(managedRoot, 'redirect'));

        expect(() => ensurePrivateDirectory(managedRoot, path.join(managedRoot, 'redirect', 'nested')))
            .toThrow(/symbolic link/i);
    });
});

describe('private environment files', () => {
    it('atomically creates and replaces a regular owner-only file', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const directory = path.join(managedRoot, 'state');
        const filePath = path.join(directory, 'config.json');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        ensurePrivateDirectory(managedRoot, directory);

        atomicWritePrivateFile(managedRoot, filePath, 'first', 0o600);
        atomicWritePrivateFile(managedRoot, filePath, 'second', 0o600);

        expect(fs.readFileSync(filePath, 'utf8')).toBe('second');
        expect(mode(directory)).toBe(0o700);
        expect(mode(filePath)).toBe(0o600);
    });

    it('rejects a symlink destination without modifying its target', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const outside = path.join(root, 'outside.txt');
        const destination = path.join(managedRoot, 'secret');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        fs.writeFileSync(outside, 'untouched', { mode: 0o600 });
        fs.symlinkSync(outside, destination);

        expect(() => atomicWritePrivateFile(managedRoot, destination, 'replacement', 0o600))
            .toThrow(/symbolic link/i);
        expect(fs.readFileSync(outside, 'utf8')).toBe('untouched');
    });

    it('rejects symlink and oversized bounded reads', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const regular = path.join(managedRoot, 'regular');
        const linked = path.join(managedRoot, 'linked');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        fs.writeFileSync(regular, '12345678', { mode: 0o600 });
        fs.symlinkSync(regular, linked);

        expect(() => readBoundedFileNoFollow(managedRoot, linked, 32)).toThrow(/symbolic link|no-follow/i);
        expect(() => readBoundedFileNoFollow(managedRoot, regular, 4)).toThrow(/too large/i);
        expect(readBoundedFileNoFollow(managedRoot, regular, 8)).toBe('12345678');
    });

    it('opens append-only logs without following a symlink', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const logDirectory = path.join(managedRoot, 'logs');
        const logPath = path.join(logDirectory, 'service.log');
        const outside = path.join(root, 'outside.log');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        ensurePrivateDirectory(managedRoot, logDirectory);

        const descriptor = openPrivateAppendFile(managedRoot, logPath);
        fs.writeSync(descriptor, 'entry\n');
        fs.closeSync(descriptor);
        expect(mode(logPath)).toBe(0o600);

        fs.unlinkSync(logPath);
        fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
        fs.symlinkSync(outside, logPath);
        expect(() => openPrivateAppendFile(managedRoot, logPath)).toThrow(/symbolic link|no-follow/i);
        expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
    });
});

describe('environment master secret', () => {
    it('persists a random 32-byte secret without embedding a placeholder', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const envDir = path.join(managedRoot, 'clever-cedar');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        ensurePrivateDirectory(managedRoot, envDir);

        const first = ensureEnvironmentMasterSecret(managedRoot, envDir);
        const second = ensureEnvironmentMasterSecret(managedRoot, envDir);
        const secretPath = path.join(envDir, 'server', 'master-secret');

        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(second).toBe(first);
        expect(first).not.toContain('idle-dev-secret');
        expect(mode(path.dirname(secretPath))).toBe(0o700);
        expect(mode(secretPath)).toBe(0o600);
        expect(fs.readFileSync(secretPath, 'utf8').trim()).toBe(first);
    });

    it.each(['idle-dev-secret', 'change-me', 'short', 'x'.repeat(63)])(
        'rejects an existing weak or placeholder secret: %j',
        (value) => {
            const root = temporaryRoot();
            const managedRoot = path.join(root, 'managed');
            const envDir = path.join(managedRoot, 'clever-cedar');
            const serverDir = path.join(envDir, 'server');
            fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(serverDir, 'master-secret'), value, { mode: 0o600 });

            expect(() => ensureEnvironmentMasterSecret(managedRoot, envDir)).toThrow(/master secret/i);
        },
    );

    it.runIf(process.platform !== 'win32')('quotes generated shell paths without evaluating metacharacters', () => {
        const root = temporaryRoot();
        const envDir = path.join(root, "managed'$(touch PWNED)");
        fs.mkdirSync(envDir, { mode: 0o700 });
        ensureEnvironmentMasterSecret(root, envDir);
        const envShPath = path.join(envDir, 'env.sh');
        fs.writeFileSync(envShPath, buildEnvSh('clever-cedar', envDir, 3100, 8100, root), { mode: 0o600 });

        const result = spawnSync('/bin/sh', [
            '-c',
            '. "$1"; secret=$(printenv IDLE_MASTER_SECRET 2>/dev/null || printf unset); data=$(printenv DATA_DIR 2>/dev/null || printf unset); printf "%s|%s|%s" "$IDLE_SERVER_URL" "$secret" "$data"',
            'sh',
            envShPath,
        ], {
            cwd: root,
            encoding: 'utf8',
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('http://localhost:3100|unset|unset');
        expect(fs.existsSync(path.join(root, 'PWNED'))).toBe(false);
    });

    it('keeps server-only configuration out of app, CLI, and daemon environments', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const envDir = path.join(managedRoot, 'clever-cedar');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        ensurePrivateDirectory(managedRoot, envDir);

        const clientEnv = buildClientEnvVars(envDir, 3100, 8100);
        const serverEnv = buildServerEnvVars(envDir, 3100, 8100, managedRoot);
        const inheritedClientEnv = mergeClientEnvironment({
            ...syntheticServerEnvironment(),
            PATH: '/usr/bin',
        }, clientEnv);
        const envSh = buildEnvSh('clever-cedar', envDir, 3100, 8100, managedRoot);

        for (const key of SERVER_ONLY_TEST_KEYS) {
            expect(clientEnv).not.toHaveProperty(key);
            expect(inheritedClientEnv).not.toHaveProperty(key);
        }
        expect(inheritedClientEnv.PATH).toBe('/usr/bin');
        expect(serverEnv.IDLE_MASTER_SECRET).toMatch(/^[a-f0-9]{64}$/);
        expect(envSh).not.toContain('master-secret');
    });

    it('does not inherit arbitrary parent secrets without an explicit pass-through', () => {
        const baseEnv = {
            PATH: '/usr/bin',
            HOME: '/Users/fixture',
            LANG: 'en_US.UTF-8',
            TERM: 'xterm-256color',
            PERSONAL_GMAIL_APP_PASSWORD: 'must-not-leak',
            EMPLOYER_CLOUD_TOKEN: 'must-not-leak',
            NODE_OPTIONS: '--require /tmp/untrusted.cjs',
        };
        const clientEnv = buildClientEnvVars('/tmp/idle-env', 3100, 8100);

        const inherited = mergeClientEnvironment(baseEnv, clientEnv);
        expect(inherited.PATH).toBe('/usr/bin');
        expect(inherited.HOME).toBe('/Users/fixture');
        expect(inherited.LANG).toBe('en_US.UTF-8');
        expect(inherited.TERM).toBe('xterm-256color');
        expect(inherited).not.toHaveProperty('PERSONAL_GMAIL_APP_PASSWORD');
        expect(inherited).not.toHaveProperty('EMPLOYER_CLOUD_TOKEN');
        expect(inherited).not.toHaveProperty('NODE_OPTIONS');

        const explicit = mergeClientEnvironment({
            ...baseEnv,
            IDLE_MASTER_SECRET: 'server-secret-must-never-pass',
            IDLE_ENV_PASSTHROUGH: 'EMPLOYER_CLOUD_TOKEN,IDLE_MASTER_SECRET',
        }, clientEnv);
        expect(explicit.EMPLOYER_CLOUD_TOKEN).toBe('must-not-leak');
        expect(explicit).not.toHaveProperty('IDLE_MASTER_SECRET');
        expect(explicit).not.toHaveProperty('PERSONAL_GMAIL_APP_PASSWORD');
        expect(explicit).not.toHaveProperty('IDLE_ENV_PASSTHROUGH');

        expect(() => mergeClientEnvironment({
            ...baseEnv,
            IDLE_ENV_PASSTHROUGH: 'NOT-A-VALID-NAME',
        }, clientEnv)).toThrow(/invalid variable name/i);
    });

    it('keeps server-only values absent in a real spawned client process', () => {
        const root = temporaryRoot();
        const envDir = path.join(root, 'managed', 'clever-cedar');
        const childEnv = mergeClientEnvironment({
            ...process.env,
            ...syntheticServerEnvironment(),
            PERSONAL_GMAIL_APP_PASSWORD: 'must-not-leak',
            EMPLOYER_CLOUD_TOKEN: 'must-not-leak',
        }, buildClientEnvVars(envDir, 3100, 8100));
        const probe = spawnSync(process.execPath, [
            '-e',
            'const keys=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(keys.filter((key)=>process.env[key]!==undefined)))',
            JSON.stringify([
                ...SERVER_ONLY_TEST_KEYS,
                'PERSONAL_GMAIL_APP_PASSWORD',
                'EMPLOYER_CLOUD_TOKEN',
            ]),
        ], {
            env: childEnv,
            encoding: 'utf8',
        });

        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stdout).toBe('[]');
    });

    it.runIf(process.platform !== 'win32')('unsets inherited server-only values when env.sh is sourced', () => {
        const root = temporaryRoot();
        const managedRoot = path.join(root, 'managed');
        const envDir = path.join(managedRoot, 'clever-cedar');
        fs.mkdirSync(managedRoot, { mode: 0o700 });
        ensurePrivateDirectory(managedRoot, envDir);
        const envShPath = path.join(envDir, 'env.sh');
        fs.writeFileSync(envShPath, buildEnvSh('clever-cedar', envDir, 3100, 8100, managedRoot), { mode: 0o600 });

        const probe = spawnSync('/bin/sh', [
            '-c',
            '. "$1"; "$2" -e \'const keys=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(keys.filter((key)=>process.env[key]!==undefined)))\' "$3"',
            'sh',
            envShPath,
            process.execPath,
            JSON.stringify(SERVER_ONLY_TEST_KEYS),
        ], {
            cwd: root,
            env: { ...process.env, ...syntheticServerEnvironment() },
            encoding: 'utf8',
        });

        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stdout).toBe('[]');
    });
});

describe('environment configuration schema', () => {
    it('accepts valid fields, recomputes derived fields, and strips unknown values', () => {
        const root = temporaryRoot();
        const envDir = path.join(root, 'clever-cedar');
        const legacyAuthenticatedUrlKey = ['authenticated', 'Web', 'Url'].join('');
        const parsed = parseEnvironmentConfigValue('clever-cedar', envDir, {
            name: 'clever-cedar',
            serverPort: 3100,
            expoPort: 8100,
            createdAt: '2026-07-11T12:00:00.000Z',
            template: 'empty',
            projectTemplate: 'lab-rat-todo-project',
            projectPath: path.join(envDir, 'project'),
            cliCommand: 'malicious command',
            [legacyAuthenticatedUrlKey]: 'https://example.invalid/?token=secret',
            unknown: 'strip me',
        });

        expect(parsed).toEqual({
            name: 'clever-cedar',
            serverPort: 3100,
            expoPort: 8100,
            createdAt: '2026-07-11T12:00:00.000Z',
            template: 'empty',
            projectTemplate: 'lab-rat-todo-project',
            projectPath: path.join(envDir, 'project'),
            cliCommand: expect.stringMatching(/^cd '.+' && yarn env:cli$/),
        });
        expect(parsed.cliCommand).not.toContain('source ');
    });

    it.each([
        { serverPort: 0 },
        { serverPort: 65536 },
        { expoPort: 3.14 },
        { createdAt: 'not-a-date' },
        { projectTemplate: '../other' },
        { projectPath: '/tmp/outside' },
        { template: 'unknown' },
    ])('rejects an invalid configuration field: %j', (override) => {
        const root = temporaryRoot();
        const envDir = path.join(root, 'clever-cedar');
        const value = {
            name: 'clever-cedar',
            serverPort: 3100,
            expoPort: 8100,
            createdAt: '2026-07-11T12:00:00.000Z',
            template: 'empty',
            projectTemplate: 'lab-rat-todo-project',
            projectPath: path.join(envDir, 'project'),
            ...override,
        };

        expect(() => parseEnvironmentConfigValue('clever-cedar', envDir, value))
            .toThrow(/invalid environment configuration/i);
    });
});

describe('managed process state', () => {
    const validState = {
        schemaVersion: 1,
        service: 'server',
        pid: 4242,
        uid: 501,
        processGroupId: 4242,
        cwd: '/tmp/idle/server',
        executable: '/usr/local/bin/node',
        commandFingerprint: 'a'.repeat(64),
        startMarker: '123456789',
        launchNonce: 'b'.repeat(64),
    };

    it('accepts a complete positive process record', () => {
        expect(parseManagedProcessState(validState, 'server')).toEqual(validState);
    });

    it.each([
        { pid: 0 },
        { pid: -1 },
        { pid: '4242junk' },
        { processGroupId: -1 },
        { uid: -1 },
        { service: 'web' },
        { commandFingerprint: 'short' },
        { startMarker: '' },
        { launchNonce: '' },
        { executable: '' },
        { cwd: '' },
    ])('rejects malformed or dangerous process state: %j', (override) => {
        expect(() => parseManagedProcessState({ ...validState, ...override }, 'server'))
            .toThrow(/process state/i);
    });

    it('rejects a reused PID or changed process identity', () => {
        const state = parseManagedProcessState(validState, 'server');
        expect(verifyManagedProcessIdentity(state, {
            pid: state.pid,
            uid: state.uid,
            processGroupId: state.processGroupId,
            cwd: state.cwd,
            executable: state.executable,
            commandFingerprint: state.commandFingerprint,
            startMarker: 'different-start',
            launchNonce: state.launchNonce,
        })).toBe(false);
    });

    it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
        'captures a real owned process identity and launch nonce',
        async () => {
            const root = temporaryRoot();
            const nonce = crypto.randomUUID().replace(/-/g, '').padEnd(64, '0');
            const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
                cwd: root,
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, IDLE_ENV_LAUNCH_NONCE: nonce },
            });
            child.unref();

            try {
                let identity = null;
                for (let attempt = 0; attempt < 20 && !identity; attempt++) {
                    identity = captureProcessIdentity(child.pid!, nonce);
                    if (!identity) await new Promise(resolve => setTimeout(resolve, 25));
                }
                expect(identity).not.toBeNull();
                expect(identity!.pid).toBe(child.pid);
                expect(identity!.launchNonce).toBe(nonce);
                expect(identity!.cwd).toBe(fs.realpathSync(root));
            } finally {
                try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
            }
        },
    );

    it('records an exec-transition runtime only when every stable identity field still matches', () => {
        const launchState = parseManagedProcessState(validState, 'server');
        const runtimeIdentity = {
            ...launchState,
            executable: '/opt/homebrew/bin/node',
            commandFingerprint: 'c'.repeat(64),
        };

        expect(verifyManagedProcessIdentity(launchState, runtimeIdentity)).toBe(false);
        const readyState = promoteManagedProcessIdentityAfterReadiness(launchState, runtimeIdentity);
        expect(verifyManagedProcessIdentity(readyState, runtimeIdentity)).toBe(true);

        for (const changedIdentity of [
            { ...runtimeIdentity, pid: runtimeIdentity.pid + 1 },
            { ...runtimeIdentity, uid: runtimeIdentity.uid + 1 },
            { ...runtimeIdentity, processGroupId: runtimeIdentity.processGroupId + 1 },
            { ...runtimeIdentity, cwd: '/tmp/idle/other' },
            { ...runtimeIdentity, startMarker: 'different-start' },
            { ...runtimeIdentity, launchNonce: 'd'.repeat(64) },
        ]) {
            expect(() => promoteManagedProcessIdentityAfterReadiness(launchState, changedIdentity))
                .toThrow(/stable process identity/i);
        }
    });
});

describe('Tailscale exposure policy', () => {
    it('updates only the two owned Serve handlers without reset or Funnel', () => {
        const commands = getTailscaleServeCommands(8081, 3005);
        expect(commands).toEqual([
            ['serve', '--bg', '8081'],
            ['serve', '--bg', '--https=8443', '3005'],
        ]);
        expect(JSON.stringify(commands)).not.toMatch(/funnel|reset/i);
    });

    it('configures the remote web bundle, attachment URLs, and CORS with exact tailnet origins', () => {
        expect(buildTailscaleAccessConfig('idle-mini.example.ts.net')).toEqual({
            webOrigin: 'https://idle-mini.example.ts.net',
            serverUrl: 'https://idle-mini.example.ts.net:8443',
            clientEnv: {
                EXPO_PUBLIC_SERVER_URL: 'https://idle-mini.example.ts.net:8443',
                EXPO_PUBLIC_IDLE_SERVER_URL: 'https://idle-mini.example.ts.net:8443',
            },
            serverEnv: {
                IDLE_CORS_ORIGIN: 'https://idle-mini.example.ts.net',
                IDLE_AUTH_AUDIENCE: 'https://idle-mini.example.ts.net:8443',
                PUBLIC_URL: 'https://idle-mini.example.ts.net:8443',
            },
        });
    });

    it.each([
        'https://idle-mini.example.ts.net',
        'idle-mini.example.ts.net/path',
        'idle mini.example.ts.net',
        '*.example.ts.net',
    ])('rejects a non-hostname Tailscale identity: %s', (hostname) => {
        expect(() => buildTailscaleAccessConfig(hostname)).toThrow(/hostname/i);
    });

    it('refuses to replace an unrelated handler on either owned port', () => {
        const status = {
            TCP: { '8443': { HTTPS: true } },
            Web: {
                'idle-mini.example.ts.net:8443': {
                    Handlers: { '/': { Proxy: 'http://127.0.0.1:5577' } },
                },
            },
        };

        expect(() => assertTailscaleServeTargetsAvailable(
            status,
            'idle-mini.example.ts.net',
            8081,
            3005,
        )).toThrow(/8443.*existing/i);
    });

    it('accepts free ports and an idempotent handler for the same local target', () => {
        expect(() => assertTailscaleServeTargetsAvailable(
            {},
            'idle-mini.example.ts.net',
            8081,
            3005,
        )).not.toThrow();

        expect(() => assertTailscaleServeTargetsAvailable(
            {
                TCP: { '8443': { HTTPS: true } },
                Web: {
                    'idle-mini.example.ts.net:8443': {
                        Handlers: { '/': { Proxy: 'http://127.0.0.1:3005' } },
                    },
                },
            },
            'idle-mini.example.ts.net',
            8081,
            3005,
        )).not.toThrow();
    });
});

describe('environment seed authentication', () => {
    it('uses replay-safe authentication then obtains a purpose-bound RPC registration credential', async () => {
        const secret = crypto.randomBytes(32);
        const challengeId = '123e4567-e89b-12d3-a456-426614174000';
        const challenge = Buffer.from('server-issued nonce').toString('base64');
        const requests: Array<{
            url: string;
            body: Record<string, unknown>;
            authorization?: string;
        }> = [];
        let pairingPublicKey: Uint8Array | null = null;
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const headers = new Headers(init?.headers);
            requests.push({
                url,
                body,
                ...(headers.has('Authorization')
                    ? { authorization: headers.get('Authorization') ?? undefined }
                    : {}),
            });
            if (url.endsWith('/v1/auth/challenge')) {
                return new Response(JSON.stringify({ version: 3, challengeId, challenge }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth')) {
                return new Response(JSON.stringify({ success: true, token: 'bootstrap-token' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth/request')) {
                if (!pairingPublicKey) {
                    pairingPublicKey = Buffer.from(String(body.publicKey), 'base64');
                    return new Response(JSON.stringify({ state: 'requested' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                const inner = encryptBoxBundle(secret, pairingPublicKey);
                const payload = encodeAuthPairingPayload({
                    version: 2,
                    token: 'seed-token',
                    rpcRegistrationToken: 'rpc-registration-token',
                    response: Buffer.from(inner).toString('base64'),
                });
                const outer = encryptBoxBundle(payload, pairingPublicKey);
                return new Response(JSON.stringify({
                    state: 'authorized',
                    response: Buffer.from(outer).toString('base64'),
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.endsWith('/v1/auth/response')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error('Unexpected seed-authentication request');
        });

        await expect(authenticateSeedClient('http://127.0.0.1:3005', secret, fetchMock))
            .resolves.toEqual({
                token: 'seed-token',
                rpcRegistrationToken: 'rpc-registration-token',
            });

        expect(requests.map(request => request.url)).toEqual([
            'http://127.0.0.1:3005/v1/auth/challenge',
            'http://127.0.0.1:3005/v1/auth',
            'http://127.0.0.1:3005/v1/auth/request',
            'http://127.0.0.1:3005/v1/auth/response',
            'http://127.0.0.1:3005/v1/auth/request',
        ]);
        expect(requests[0].body).toEqual({ version: 3, publicKey: expect.any(String) });
        expect(requests[1].body).toEqual({
            version: 3,
            publicKey: requests[0].body.publicKey,
            challengeId,
            signature: expect.any(String),
        });
        expect(requests[1].body).not.toHaveProperty('challenge');
        expect(tweetnacl.sign.detached.verify(
            buildAuthChallengeMessage('http://127.0.0.1:3005', challengeId, challenge),
            Buffer.from(String(requests[1].body.signature), 'base64'),
            Buffer.from(String(requests[1].body.publicKey), 'base64'),
        )).toBe(true);
        expect(Buffer.from(String(requests[1].body.publicKey), 'base64'))
            .toEqual(Buffer.from(tweetnacl.sign.keyPair.fromSeed(secret).publicKey));
        expect(requests[2].body).toEqual({
            publicKey: expect.any(String),
            supportsV2: true,
        });
        expect(requests[3]).toEqual({
            url: 'http://127.0.0.1:3005/v1/auth/response',
            authorization: 'Bearer bootstrap-token',
            body: {
                publicKey: requests[2].body.publicKey,
                response: expect.any(String),
            },
        });
        expect(requests[4].body).toEqual(requests[2].body);
    });

    it('rejects a malformed server challenge before submitting a proof', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            challengeId: 'not-a-uuid',
            challenge: Buffer.from('nonce').toString('base64'),
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));

        await expect(authenticateSeedClient(
            'http://127.0.0.1:3005',
            crypto.randomBytes(32),
            fetchMock,
        )).rejects.toThrow(/challenge response was invalid/i);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
