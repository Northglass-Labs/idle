import { describe, expect, it } from 'vitest';
import {
    getExplicitLiveTestTarget,
    LIVE_TEST_ALLOW_FLAG,
    LIVE_TEST_URL_VARIABLE,
} from './liveTestTarget';

describe('getExplicitLiveTestTarget', () => {
    it('requires both an explicit URL and the live-test allow flag', () => {
        expect(getExplicitLiveTestTarget({})).toBeNull();
        expect(getExplicitLiveTestTarget({ [LIVE_TEST_URL_VARIABLE]: 'https://relay.example.test' })).toBeNull();
        expect(getExplicitLiveTestTarget({ [LIVE_TEST_ALLOW_FLAG]: '1' })).toBeNull();
    });

    it('returns a normalized origin only when both controls are present', () => {
        expect(getExplicitLiveTestTarget({
            [LIVE_TEST_URL_VARIABLE]: 'https://relay.example.test/',
            [LIVE_TEST_ALLOW_FLAG]: '1',
        })).toBe('https://relay.example.test');
    });

    it.each([
        'not-a-url',
        'file:///tmp/relay',
        ['https://user', ':password@relay.example.test'].join(''),
        'https://relay.example.test/api',
        'https://relay.example.test?token=secret',
    ])('rejects an unsafe explicit target: %s', (target) => {
        expect(() => getExplicitLiveTestTarget({
            [LIVE_TEST_URL_VARIABLE]: target,
            [LIVE_TEST_ALLOW_FLAG]: '1',
        })).toThrow(/TEST_SERVER_URL/);
    });
});
