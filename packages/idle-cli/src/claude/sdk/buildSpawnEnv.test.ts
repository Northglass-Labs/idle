import { describe, it, expect } from 'vitest';
import { buildSpawnEnv } from './buildSpawnEnv';

describe('buildSpawnEnv — defends against child-environment isolation process.env mutation', () => {
    it('returns a NEW object (not the same reference as baseEnv) so callers cannot mutate process.env', () => {
        // Returning baseEnv directly would let consumer mutations escape into process.env.
        const base: NodeJS.ProcessEnv = { PATH: '/bin', NODE_ENV: 'test' };
        const out = buildSpawnEnv({ baseEnv: base });
        expect(out).not.toBe(base);
        expect(out).toEqual(base);
    });

    it('returns a copy of baseEnv when additionalEnv is undefined', () => {
        const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const out = buildSpawnEnv({ baseEnv: base, additionalEnv: undefined });
        expect(out).toEqual({ PATH: '/usr/bin' });
        expect(out).not.toBe(base);
    });

    it('returns a copy of baseEnv when additionalEnv is an empty object', () => {
        const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const out = buildSpawnEnv({ baseEnv: base, additionalEnv: {} });
        expect(out).toEqual({ PATH: '/usr/bin' });
    });

    it('merges additionalEnv on top of baseEnv', () => {
        const base: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/home/user' };
        const out = buildSpawnEnv({
            baseEnv: base,
            additionalEnv: { ANTHROPIC_API_KEY: 'sk-test-secret' },
        });
        expect(out).toEqual({
            PATH: '/bin',
            HOME: '/home/user',
            ANTHROPIC_API_KEY: 'sk-test-secret',
        });
    });

    it('additionalEnv wins on collision — per-session config can override inherited values', () => {
        const base: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
        const out = buildSpawnEnv({
            baseEnv: base,
            additionalEnv: { ANTHROPIC_BASE_URL: 'https://proxy.internal' },
        });
        expect(out.ANTHROPIC_BASE_URL).toBe('https://proxy.internal');
    });

    it('mutating the returned env does NOT leak back into baseEnv', () => {
        const base: NodeJS.ProcessEnv = { PATH: '/bin' };
        const out = buildSpawnEnv({ baseEnv: base, additionalEnv: { FOO: 'bar' } });
        out.PATH = '/tampered';
        out.FOO = 'tampered';
        expect(base.PATH).toBe('/bin');
        expect(base.FOO).toBeUndefined();
    });
});
