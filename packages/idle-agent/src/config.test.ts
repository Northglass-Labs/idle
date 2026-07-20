import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL, loadConfig } from './config';

function credentialedTestUrl(hostAndPath: string): string {
    const url = new URL(`https://${hostAndPath}`);
    url.username = 'test-user';
    url.password = 'test-password';
    return url.toString();
}

describe('config', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        delete process.env.IDLE_SERVER_URL;
        delete process.env.IDLE_HOME_DIR;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('defaults', () => {
        it('uses default server URL', () => {
            const config = loadConfig();
            expect(config.serverUrl).toBe(DEFAULT_SERVER_URL);
        });

        it('uses default home directory', () => {
            const config = loadConfig();
            expect(config.homeDir).toBe(join(homedir(), '.idle'));
        });

        it('derives credential path from home directory', () => {
            const config = loadConfig();
            expect(config.credentialPath).toBe(join(homedir(), '.idle', 'agent.key'));
        });
    });

    describe('env var overrides', () => {
        it('overrides server URL with IDLE_SERVER_URL', () => {
            process.env.IDLE_SERVER_URL = 'https://custom-server.example.com';
            const config = loadConfig();
            expect(config.serverUrl).toBe('https://custom-server.example.com');
        });

        it('overrides home directory with IDLE_HOME_DIR', () => {
            process.env.IDLE_HOME_DIR = '/tmp/custom-idle';
            const config = loadConfig();
            expect(config.homeDir).toBe('/tmp/custom-idle');
        });

        it('derives credential path from overridden home directory', () => {
            process.env.IDLE_HOME_DIR = '/tmp/custom-idle';
            const config = loadConfig();
            expect(config.credentialPath).toBe('/tmp/custom-idle/agent.key');
        });

        it('allows both overrides simultaneously', () => {
            process.env.IDLE_SERVER_URL = 'https://other.example.com';
            process.env.IDLE_HOME_DIR = '/opt/idle';
            const config = loadConfig();
            expect(config.serverUrl).toBe('https://other.example.com');
            expect(config.homeDir).toBe('/opt/idle');
            expect(config.credentialPath).toBe('/opt/idle/agent.key');
        });

        it.each(['', '   ', '.', 'relative/idle', '/'])(
            'rejects an unsafe credential home override: %s',
            raw => {
                process.env.IDLE_HOME_DIR = raw;
                expect(() => loadConfig()).toThrow(/IDLE_HOME_DIR/);
            },
        );

        it.each([
            ['HTTPS://Relay.Example.COM:443/', 'https://relay.example.com'],
            ['https://relay.example.com:8443/', 'https://relay.example.com:8443'],
            ['http://localhost:3005/', 'http://localhost:3005'],
            ['http://dev.localhost:3005', 'http://dev.localhost:3005'],
            ['http://127.42.0.1:3005', 'http://127.42.0.1:3005'],
            ['http://[::1]:3005/', 'http://[::1]:3005'],
        ])('canonicalizes a credential-free server origin: %s', (raw, expected) => {
            process.env.IDLE_SERVER_URL = raw;
            expect(loadConfig().serverUrl).toBe(expected);
        });

        it.each([
            '',
            '   ',
            'relay.example.com',
            '//relay.example.com',
            'ftp://relay.example.com',
            'http://relay.example.com',
            'http://192.168.1.10:3005',
            credentialedTestUrl('relay.example.com'),
            'https://relay.example.com/v1',
            'https://relay.example.com/?target=other',
            'https://relay.example.com/#fragment',
            `https://${'a'.repeat(2048)}.example.com`,
        ])('rejects an unsafe or non-origin server URL: %s', (raw) => {
            process.env.IDLE_SERVER_URL = raw;
            expect(() => loadConfig()).toThrow(/IDLE_SERVER_URL/);
        });
    });
});
