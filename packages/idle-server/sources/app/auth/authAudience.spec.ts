import { describe, expect, it } from 'vitest';
import { loadAuthAudience } from './authAudience';

describe('authentication audience configuration', () => {
    it('canonicalizes the independently configured relay origin', () => {
        expect(loadAuthAudience({
            IDLE_AUTH_AUDIENCE: 'https://RELAY.Example.Test:443',
        })).toBe('https://relay.example.test');
        expect(loadAuthAudience({
            IDLE_AUTH_AUDIENCE: 'http://localhost:3005',
        })).toBe('http://localhost:3005');
    });

    it.each([
        {},
        { IDLE_AUTH_AUDIENCE: 'http://relay.example.test' },
        { IDLE_AUTH_AUDIENCE: 'https://relay.example.test/path' },
        { IDLE_AUTH_AUDIENCE: 'https://user@relay.example.test' },
    ])('fails closed for a missing or unsafe trusted audience: %j', (environment) => {
        expect(() => loadAuthAudience(environment)).toThrow(/IDLE_AUTH_AUDIENCE/);
    });
});
