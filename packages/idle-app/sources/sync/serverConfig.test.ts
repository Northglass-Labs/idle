import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, Map<string, string>>());

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        private readonly store: Map<string, string>;
        constructor(options?: { id?: string }) {
            const id = options?.id ?? 'default';
            if (!stores.has(id)) stores.set(id, new Map());
            this.store = stores.get(id)!;
        }
        getString(key: string) { return this.store.get(key); }
        set(key: string, value: string) { this.store.set(key, value); }
        delete(key: string) { this.store.delete(key); }
    },
}));

import { getServerUrl, setServerUrl, validateServerUrl } from './serverConfig';

describe('server URL transport policy', () => {
    beforeEach(() => {
        for (const store of stores.values()) store.clear();
        setServerUrl(null);
    });

    it('accepts HTTPS and loopback HTTP development endpoints', () => {
        expect(validateServerUrl('https://relay.example.com').valid).toBe(true);
        expect(validateServerUrl('http://localhost:3005').valid).toBe(true);
        expect(validateServerUrl('http://dev.localhost:3005').valid).toBe(true);
        expect(validateServerUrl('http://127.42.0.1:3005').valid).toBe(true);
        expect(validateServerUrl('http://[::1]:3005').valid).toBe(true);
    });

    it('rejects cleartext non-loopback and credential-bearing endpoints', () => {
        expect(validateServerUrl('http://relay.example.com').valid).toBe(false);
        expect(validateServerUrl('http://192.168.1.10:3005').valid).toBe(false);
        expect(validateServerUrl(['https://user', ':pass@relay.example.com'].join('')).valid).toBe(false);
        expect(() => setServerUrl('http://relay.example.com')).toThrow(/https/i);
    });

    it('accepts only a canonical relay origin, never a path, query, or fragment', () => {
        expect(validateServerUrl('https://relay.example.com/api').valid).toBe(false);
        expect(validateServerUrl('https://relay.example.com?target=other').valid).toBe(false);
        expect(validateServerUrl('https://relay.example.com#other').valid).toBe(false);

        setServerUrl('https://relay.example.com/');
        expect(getServerUrl()).toBe('https://relay.example.com');
    });

    it('continues to persist a valid custom HTTPS endpoint', () => {
        setServerUrl('https://relay.example.com');
        expect(getServerUrl()).toBe('https://relay.example.com');
    });

    it('does not reuse a legacy cleartext remote endpoint already on disk', () => {
        stores.get('server-config')!.set('custom-server-url', 'http://legacy-relay.example.com');
        const fallback = getServerUrl();
        expect(fallback).not.toContain('legacy-relay.example.com');
        expect(new URL(fallback).protocol).toBe('https:');
    });
});
