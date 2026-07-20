import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tweetnacl from 'tweetnacl';
import { readCredentials, writeCredentials, clearCredentials, requireCredentials } from './credentials';
import { getRandomBytes, deriveContentKeyPair, encodeBase64 } from './encryption';
import type { Config } from './config';

function makeTestConfig(): Config {
    const homeDir = mkdtempSync(join(tmpdir(), 'idle-agent-test-'));
    return {
        serverUrl: 'https://relay.example.test',
        homeDir,
        credentialPath: join(homeDir, 'agent.key'),
    };
}

describe('credentials', () => {
    let config: Config;

    beforeEach(() => {
        config = makeTestConfig();
    });

    afterEach(() => {
        rmSync(config.homeDir, { recursive: true, force: true });
    });

    describe('readCredentials / writeCredentials round-trip', () => {
        it('writes and reads back credentials', () => {
            const token = 'test-jwt-token';
            const secret = getRandomBytes(32);

            writeCredentials(config, token, secret);
            const creds = readCredentials(config);

            expect(creds).not.toBeNull();
            expect(creds!.token).toBe(token);
            expect(creds!.secret).toEqual(secret);
        });

        it('derives contentKeyPair correctly on read', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);
            const expectedKeyPair = deriveContentKeyPair(secret);

            writeCredentials(config, token, secret);
            const creds = readCredentials(config);

            expect(creds!.contentKeyPair.publicKey).toEqual(expectedKeyPair.publicKey);
            expect(creds!.contentKeyPair.secretKey).toEqual(expectedKeyPair.secretKey);
        });

        it('stores secret as base64 in the file', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);

            writeCredentials(config, token, secret);
            const raw = JSON.parse(readFileSync(config.credentialPath, 'utf-8'));

            expect(raw).toEqual({
                version: 3,
                token,
                secret: encodeBase64(secret),
                accountPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(secret).publicKey),
                relayAudience: 'https://relay.example.test',
            });
        });

        it('rejects legacy, relay-rebound, and account-identity-rebound credentials', () => {
            const secret = getRandomBytes(32);
            writeFileSync(config.credentialPath, JSON.stringify({
                token: 'legacy-token',
                secret: encodeBase64(secret),
            }), { mode: 0o600 });
            expect(readCredentials(config)).toBeNull();

            writeCredentials(config, 'current-token', secret);
            const valid = JSON.parse(readFileSync(config.credentialPath, 'utf8'));
            writeFileSync(config.credentialPath, JSON.stringify({
                ...valid,
                relayAudience: 'https://other-relay.example.test',
            }));
            expect(readCredentials(config)).toBeNull();

            writeFileSync(config.credentialPath, JSON.stringify({
                ...valid,
                accountPublicKey: encodeBase64(getRandomBytes(32)),
            }));
            expect(readCredentials(config)).toBeNull();
        });

        it('creates parent directory if missing', () => {
            const deepConfig: Config = {
                ...config,
                credentialPath: join(config.homeDir, 'nested', 'dir', 'agent.key'),
            };

            writeCredentials(deepConfig, 'token', getRandomBytes(32));
            expect(existsSync(deepConfig.credentialPath)).toBe(true);
        });

        it.skipIf(process.platform === 'win32')('writes atomically with an owner-only file and private final directory', () => {
            const deepConfig: Config = {
                ...config,
                credentialPath: join(config.homeDir, 'private', 'agent.key'),
            };

            writeCredentials(deepConfig, 'token', getRandomBytes(32));

            expect(lstatSync(deepConfig.credentialPath).mode & 0o777).toBe(0o600);
            expect(lstatSync(join(config.homeDir, 'private')).mode & 0o777).toBe(0o700);
        });

        it.skipIf(process.platform === 'win32')('repairs a permissive regular target by replacing it with a private file', () => {
            writeFileSync(config.credentialPath, JSON.stringify({
                token: 'old-token',
                secret: encodeBase64(getRandomBytes(32)),
            }), { mode: 0o644 });
            chmodSync(config.credentialPath, 0o644);

            const replacementSecret = getRandomBytes(32);
            writeCredentials(config, 'replacement-token', replacementSecret);

            expect(lstatSync(config.credentialPath).mode & 0o777).toBe(0o600);
            expect(readCredentials(config)).toMatchObject({ token: 'replacement-token' });
        });

        it('repairs an oversized owned regular target without reading it', () => {
            writeFileSync(config.credentialPath, Buffer.alloc(64 * 1024, 0x61), { mode: 0o600 });
            const replacementSecret = getRandomBytes(32);

            writeCredentials(config, 'replacement-token', replacementSecret);

            expect(readCredentials(config)).toMatchObject({
                token: 'replacement-token',
                secret: replacementSecret,
            });
        });

        it('rejects invalid values before replacing an existing credential', () => {
            const originalSecret = getRandomBytes(32);
            writeCredentials(config, 'original-token', originalSecret);
            const original = readFileSync(config.credentialPath);

            expect(() => writeCredentials(config, '', getRandomBytes(32))).toThrow(/token/i);
            expect(() => writeCredentials(config, 'x'.repeat(16 * 1024 + 1), getRandomBytes(32))).toThrow(/token/i);
            expect(() => writeCredentials(config, 'replacement', getRandomBytes(31))).toThrow(/32 bytes/i);
            expect(() => writeCredentials(config, 'replacement', getRandomBytes(33))).toThrow(/32 bytes/i);
            expect(readFileSync(config.credentialPath)).toEqual(original);
        });

        it.skipIf(process.platform === 'win32')('refuses a symlinked target without changing its destination', () => {
            const destination = join(config.homeDir, 'outside.key');
            writeFileSync(destination, 'do-not-change', { mode: 0o600 });
            symlinkSync(destination, config.credentialPath);

            expect(() => writeCredentials(config, 'token', getRandomBytes(32))).toThrow(/symbolic link/i);
            expect(readFileSync(destination, 'utf8')).toBe('do-not-change');
        });

        it.skipIf(process.platform === 'win32')('refuses a symlinked parent component', () => {
            const destination = join(config.homeDir, 'destination');
            mkdirSync(destination, { mode: 0o700 });
            const linkedDirectory = join(config.homeDir, 'linked');
            symlinkSync(destination, linkedDirectory);
            const linkedConfig = {
                ...config,
                credentialPath: join(linkedDirectory, 'agent.key'),
            };

            expect(() => writeCredentials(linkedConfig, 'token', getRandomBytes(32))).toThrow(/symbolic link/i);
            expect(existsSync(join(destination, 'agent.key'))).toBe(false);
        });
    });

    describe('readCredentials with missing file', () => {
        it('returns null when credential file does not exist', () => {
            const creds = readCredentials(config);
            expect(creds).toBeNull();
        });

        it('rejects oversized, malformed, and non-canonical credential data', () => {
            const invalidValues: unknown[] = [
                [],
                null,
                { token: 'token' },
                { secret: encodeBase64(getRandomBytes(32)) },
                { token: 'token', secret: encodeBase64(getRandomBytes(32)), extra: true },
                { token: '', secret: encodeBase64(getRandomBytes(32)) },
                { token: 'token with spaces', secret: encodeBase64(getRandomBytes(32)) },
                { token: 'token\nheader', secret: encodeBase64(getRandomBytes(32)) },
                { token: 'x'.repeat(16 * 1024 + 1), secret: encodeBase64(getRandomBytes(32)) },
                { token: 'token', secret: 'not-base64!' },
                { token: 'token', secret: encodeBase64(getRandomBytes(31)) },
                { token: 'token', secret: encodeBase64(getRandomBytes(33)) },
                { token: 'token', secret: `${encodeBase64(getRandomBytes(32))}\n` },
            ];

            for (const value of invalidValues) {
                writeFileSync(config.credentialPath, JSON.stringify(value), { mode: 0o600 });
                expect(readCredentials(config)).toBeNull();
            }

            writeFileSync(config.credentialPath, Buffer.alloc(64 * 1024, 0x61), { mode: 0o600 });
            expect(readCredentials(config)).toBeNull();

            writeFileSync(config.credentialPath, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
            expect(readCredentials(config)).toBeNull();
        });

        it.skipIf(process.platform === 'win32')('refuses permissive, symlinked, and multiply-linked credential files', () => {
            const valid = JSON.stringify({
                token: 'token',
                secret: encodeBase64(getRandomBytes(32)),
            });

            writeFileSync(config.credentialPath, valid, { mode: 0o644 });
            expect(readCredentials(config)).toBeNull();

            rmSync(config.credentialPath);
            const destination = join(config.homeDir, 'destination.key');
            writeFileSync(destination, valid, { mode: 0o600 });
            symlinkSync(destination, config.credentialPath);
            expect(readCredentials(config)).toBeNull();

            rmSync(config.credentialPath);
            linkSync(destination, config.credentialPath);
            expect(readCredentials(config)).toBeNull();
        });

        it.skipIf(process.platform === 'win32')('refuses a credential beneath a symlinked directory', () => {
            const destination = join(config.homeDir, 'destination');
            mkdirSync(destination, { mode: 0o700 });
            writeFileSync(join(destination, 'agent.key'), JSON.stringify({
                token: 'token',
                secret: encodeBase64(getRandomBytes(32)),
            }), { mode: 0o600 });
            const linkedDirectory = join(config.homeDir, 'linked');
            symlinkSync(destination, linkedDirectory);

            expect(readCredentials({
                ...config,
                credentialPath: join(linkedDirectory, 'agent.key'),
            })).toBeNull();
        });

        it.skipIf(process.platform === 'win32')('refuses a symlink hidden above IDLE_HOME_DIR', () => {
            const destination = join(config.homeDir, 'destination');
            const nestedHome = join(destination, 'nested-home');
            mkdirSync(nestedHome, { recursive: true, mode: 0o700 });
            writeFileSync(join(nestedHome, 'agent.key'), JSON.stringify({
                token: 'token',
                secret: encodeBase64(getRandomBytes(32)),
            }), { mode: 0o600 });
            const linkedParent = join(config.homeDir, 'linked-parent');
            symlinkSync(destination, linkedParent);
            const symlinkedHome = join(linkedParent, 'nested-home');

            expect(readCredentials({
                ...config,
                homeDir: symlinkedHome,
                credentialPath: join(symlinkedHome, 'agent.key'),
            })).toBeNull();
        });
    });

    describe('clearCredentials', () => {
        it('removes the credential file', () => {
            writeCredentials(config, 'token', getRandomBytes(32));
            expect(existsSync(config.credentialPath)).toBe(true);

            clearCredentials(config);
            expect(existsSync(config.credentialPath)).toBe(false);
        });

        it('does not throw when file does not exist', () => {
            expect(() => clearCredentials(config)).not.toThrow();
        });

        it.skipIf(process.platform === 'win32')('refuses a symlinked target without deleting either path', () => {
            const destination = join(config.homeDir, 'outside.key');
            writeFileSync(destination, 'keep', { mode: 0o600 });
            symlinkSync(destination, config.credentialPath);

            expect(() => clearCredentials(config)).toThrow(/symbolic link/i);
            expect(existsSync(config.credentialPath)).toBe(true);
            expect(readFileSync(destination, 'utf8')).toBe('keep');
        });

        it('can remove an oversized owned regular target without reading it', () => {
            writeFileSync(config.credentialPath, Buffer.alloc(64 * 1024, 0x61), { mode: 0o600 });

            expect(() => clearCredentials(config)).not.toThrow();
            expect(existsSync(config.credentialPath)).toBe(false);
        });
    });

    describe('requireCredentials', () => {
        it('returns credentials when file exists', () => {
            const token = 'test-token';
            const secret = getRandomBytes(32);
            writeCredentials(config, token, secret);

            const creds = requireCredentials(config);
            expect(creds.token).toBe(token);
            expect(creds.secret).toEqual(secret);
        });

        it('throws when credentials are missing', () => {
            expect(() => requireCredentials(config)).toThrow(
                'Not authenticated. Run `idle-agent auth login` first.'
            );
        });
    });

    describe('contentKeyPair derivation from secret', () => {
        it('produces 32-byte public and secret keys', () => {
            const secret = getRandomBytes(32);
            writeCredentials(config, 'token', secret);
            const creds = readCredentials(config);

            expect(creds!.contentKeyPair.publicKey.length).toBe(32);
            expect(creds!.contentKeyPair.secretKey.length).toBe(32);
        });

        it('is deterministic — same secret produces same keypair', () => {
            const secret = getRandomBytes(32);

            writeCredentials(config, 'token1', secret);
            const creds1 = readCredentials(config);

            writeCredentials(config, 'token2', secret);
            const creds2 = readCredentials(config);

            expect(creds1!.contentKeyPair.publicKey).toEqual(creds2!.contentKeyPair.publicKey);
            expect(creds1!.contentKeyPair.secretKey).toEqual(creds2!.contentKeyPair.secretKey);
        });

        it('different secrets produce different keypairs', () => {
            const secret1 = getRandomBytes(32);
            const secret2 = getRandomBytes(32);

            writeCredentials(config, 'token', secret1);
            const creds1 = readCredentials(config);

            writeCredentials(config, 'token', secret2);
            const creds2 = readCredentials(config);

            expect(creds1!.contentKeyPair.publicKey).not.toEqual(creds2!.contentKeyPair.publicKey);
        });
    });
});
