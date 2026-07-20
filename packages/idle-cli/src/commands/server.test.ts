import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    clearInheritedServerSecretEnvironment,
    createServerChildEnvironment,
    ensureMasterSecretFile,
    formatServerUrl,
    loadOrCreateMasterSecret,
    openedMasterSecretMatchesPath,
    parseServerOptions,
} from './server';

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'idle-server-command-')));
    tempRoots.push(root);
    return root;
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('parseServerOptions', () => {
    it('accepts exact integer ports across the valid range', () => {
        expect(parseServerOptions(['--port', '1'])?.port).toBe(1);
        expect(parseServerOptions(['--port', '65535'])?.port).toBe(65535);
    });

    it('rejects missing, partial, decimal, signed, and out-of-range ports', () => {
        for (const args of [
            ['--port'],
            ['--port', '123abc'],
            ['--port', '1.5'],
            ['--port', '+80'],
            ['--port', '-1'],
            ['--port', '0'],
            ['--port', '65536'],
        ]) {
            expect(() => parseServerOptions(args), args.join(' ')).toThrow(/port/i);
        }
    });

    it('accepts only localhost or a syntactically valid IP address', () => {
        for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '2001:db8::1']) {
            expect(parseServerOptions(['--host', host])?.host).toBe(host);
        }
        for (const host of [
            '',
            'example.test',
            'http://127.0.0.1',
            '127.0.0.1:4000',
            '127.0.0.1\nmalicious-header: yes',
            '--reset',
        ]) {
            expect(() => parseServerOptions(['--host', host]), JSON.stringify(host)).toThrow(/host/i);
        }
        expect(() => parseServerOptions(['--host'])).toThrow(/host/i);
    });

    it('formats safe URLs for wildcard and IPv6 bind addresses', () => {
        expect(formatServerUrl('0.0.0.0', 4505)).toBe('http://127.0.0.1:4505');
        expect(formatServerUrl('::', 4505)).toBe('http://[::1]:4505');
        expect(formatServerUrl('::1', 4505)).toBe('http://[::1]:4505');
        expect(formatServerUrl('2001:db8::1', 4505)).toBe('http://[2001:db8::1]:4505');
    });

    it('does not accept a master secret on the process argument list', () => {
        expect(() => parseServerOptions(['--master-secret', 'a'.repeat(64)])).toThrow(/unknown/i);
    });
});

describe('loadOrCreateMasterSecret', () => {
    it('atomically creates a 32-byte hex secret under 0700/0600 permissions', () => {
        const dataDir = path.join(makeTempRoot(), 'server-data');
        const secret = loadOrCreateMasterSecret(dataDir);

        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(path.join(dataDir, 'master-secret'), 'utf8')).toBe(secret);
        if (process.platform !== 'win32') {
            expect(lstatSync(dataDir).mode & 0o777).toBe(0o700);
            expect(lstatSync(path.join(dataDir, 'master-secret')).mode & 0o777).toBe(0o600);
        }
    });

    it('reuses a valid secret and repairs overly broad file and directory modes', () => {
        const dataDir = path.join(makeTempRoot(), 'server-data');
        mkdirSync(dataDir, { mode: 0o755 });
        const secretFile = path.join(dataDir, 'master-secret');
        const secret = 'a0'.repeat(32);
        writeFileSync(secretFile, secret, { mode: 0o644 });
        chmodSync(dataDir, 0o755);
        chmodSync(secretFile, 0o644);

        expect(loadOrCreateMasterSecret(dataDir)).toBe(secret);
        if (process.platform !== 'win32') {
            expect(lstatSync(dataDir).mode & 0o777).toBe(0o700);
            expect(lstatSync(secretFile).mode & 0o777).toBe(0o600);
        }
    });

    it('rejects weak, malformed, and whitespace-padded existing secrets without overwriting', () => {
        for (const weak of ['change-me', 'a'.repeat(32), 'z'.repeat(64), `${'a'.repeat(64)}\n`]) {
            const dataDir = path.join(makeTempRoot(), 'server-data');
            mkdirSync(dataDir, { mode: 0o700 });
            const secretFile = path.join(dataDir, 'master-secret');
            writeFileSync(secretFile, weak, { mode: 0o600 });

            expect(() => loadOrCreateMasterSecret(dataDir)).toThrow(/64 hexadecimal/i);
            expect(readFileSync(secretFile, 'utf8')).toBe(weak);
        }
    });

    it.runIf(process.platform !== 'win32')('rejects a master-secret symlink without reading or modifying its target', () => {
        const root = makeTempRoot();
        const dataDir = path.join(root, 'server-data');
        mkdirSync(dataDir, { mode: 0o700 });
        const target = path.join(root, 'target-secret');
        const secret = 'a0'.repeat(32);
        writeFileSync(target, secret, { mode: 0o644 });
        chmodSync(target, 0o644);
        symlinkSync(target, path.join(dataDir, 'master-secret'));

        expect(() => loadOrCreateMasterSecret(dataDir)).toThrow(/symbolic link/i);
        expect(readFileSync(target, 'utf8')).toBe(secret);
        expect(lstatSync(target).mode & 0o777).toBe(0o644);
    });

    it.runIf(process.platform !== 'win32')('rejects a symlinked server data directory', () => {
        const root = makeTempRoot();
        const target = path.join(root, 'target');
        mkdirSync(target, { mode: 0o700 });
        const dataDir = path.join(root, 'server-data');
        symlinkSync(target, dataDir);

        expect(() => loadOrCreateMasterSecret(dataDir)).toThrow(/symbolic link/i);
    });

    it.runIf(process.platform !== 'win32')('rejects a symlinked ancestor before creating or resetting server data', () => {
        const root = makeTempRoot();
        const target = path.join(root, 'target-home');
        mkdirSync(target, { mode: 0o700 });
        const linkedHome = path.join(root, 'linked-home');
        symlinkSync(target, linkedHome);

        expect(() => ensureMasterSecretFile(path.join(linkedHome, 'server-data')))
            .toThrow(/symbolic link/i);
        expect(existsSync(path.join(target, 'server-data'))).toBe(false);
    });

    it('rejects non-canonical file sizes before accepting stored secret content', () => {
        for (const contents of [Buffer.alloc(63, 0x61), Buffer.alloc(1024 * 1024, 0x61)]) {
            const dataDir = path.join(makeTempRoot(), 'server-data');
            mkdirSync(dataDir, { mode: 0o700 });
            writeFileSync(path.join(dataDir, 'master-secret'), contents, { mode: 0o600 });

            expect(() => loadOrCreateMasterSecret(dataDir)).toThrow(/exactly 64/i);
        }

        const source = readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
        const reader = source.slice(
            source.indexOf('function readExistingMasterSecret'),
            source.indexOf('function createMasterSecretFile'),
        );
        expect(reader.indexOf('info.size !== 64')).toBeGreaterThanOrEqual(0);
        expect(reader.indexOf('info.size !== 64')).toBeLessThan(reader.indexOf('Buffer.alloc(65)'));
        expect(reader.indexOf('info.size !== 64')).toBeLessThan(reader.indexOf('readSync('));
    });

    it('requires the opened file descriptor to match the path inode', () => {
        expect(openedMasterSecretMatchesPath({ dev: 7, ino: 11 }, { dev: 7, ino: 11 })).toBe(true);
        expect(openedMasterSecretMatchesPath({ dev: 7, ino: 11 }, { dev: 8, ino: 11 })).toBe(false);
        expect(openedMasterSecretMatchesPath({ dev: 7, ino: 11 }, { dev: 7, ino: 12 })).toBe(false);
    });
});

describe('server runtime master-secret file boundary', () => {
    it('removes inherited secret sources from the long-lived CLI process environment', () => {
        const environment = {
            IDLE_MASTER_SECRET: 'a0'.repeat(32),
            IDLE_MASTER_SECRET_FILE: '/tmp/inherited-master-secret',
            SAFE_VALUE: 'retained',
        };

        clearInheritedServerSecretEnvironment(environment);

        expect(environment).toEqual({ SAFE_VALUE: 'retained' });
    });

    it('passes only the validated durable secret-file path to server children', () => {
        const dataDir = path.join(makeTempRoot(), 'server-data');
        const secretFile = ensureMasterSecretFile(dataDir);
        const environment = createServerChildEnvironment({
            IDLE_MASTER_SECRET: 'b7'.repeat(32),
            IDLE_MASTER_SECRET_FILE: '/tmp/stale-source',
            SAFE_VALUE: 'retained',
        }, {
            dataDir,
            pgliteDir: path.join(dataDir, 'pglite'),
            secretFile,
            port: 3005,
            host: '127.0.0.1',
            serverUrl: 'http://127.0.0.1:3005',
        });

        expect(secretFile).toBe(path.join(dataDir, 'master-secret'));
        expect(readFileSync(secretFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
        if (process.platform !== 'win32') {
            expect(lstatSync(secretFile).mode & 0o777).toBe(0o600);
        }
        expect(environment.IDLE_MASTER_SECRET).toBeUndefined();
        expect(environment.IDLE_MASTER_SECRET_FILE).toBe(secretFile);
        expect(environment.SAFE_VALUE).toBe('retained');
        const source = readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
        expect(source).not.toContain('.master-secret.runtime.');
        const ensureHelper = source.slice(
            source.indexOf('export function ensureMasterSecretFile'),
            source.indexOf('export function loadOrCreateMasterSecret'),
        );
        expect(ensureHelper).toContain('validateExistingMasterSecretFile(file)');
        expect(ensureHelper).not.toContain('readExistingMasterSecret(file)');
        expect(source).not.toContain("randomBytes(32).toString('hex')");
    });
});
