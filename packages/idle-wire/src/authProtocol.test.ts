import { describe, expect, it } from 'vitest';

import {
    buildAccountPairingMessage,
    buildAuthChallengeMessage,
    decodeAccountPairingPayload,
    decodeAuthPairingPayload,
    encodeAccountPairingPayload,
    encodeAuthPairingPayload,
    formatAccountPairingCode,
} from './authProtocol';

describe('auth protocol v3', () => {
    it('binds the signed server challenge to a canonical relay audience', () => {
        const message = new TextDecoder().decode(buildAuthChallengeMessage(
            'https://IDLE.TEST:443',
            '123e4567-e89b-12d3-a456-426614174000',
            'AQIDBA==',
        ));

        expect(message).toBe(JSON.stringify({
            type: 'idle-auth',
            version: 3,
            audience: 'https://idle.test',
            challengeId: '123e4567-e89b-12d3-a456-426614174000',
            challenge: 'AQIDBA==',
        }));
    });

    it('does not allow a proof to cross relay audiences', () => {
        const challengeId = '123e4567-e89b-12d3-a456-426614174000';
        const challenge = 'AQIDBA==';

        expect(buildAuthChallengeMessage('https://relay-a.test', challengeId, challenge))
            .not.toEqual(buildAuthChallengeMessage('https://relay-b.test', challengeId, challenge));
        expect(buildAuthChallengeMessage('https://RELAY-A.test:443', challengeId, challenge))
            .toEqual(buildAuthChallengeMessage('https://relay-a.test', challengeId, challenge));
    });

    it('rejects an unsafe relay audience before signing', () => {
        expect(() => buildAuthChallengeMessage(
            'http://relay.example.test',
            '123e4567-e89b-12d3-a456-426614174000',
            'AQIDBA==',
        )).toThrow(/HTTPS unless it targets loopback/);
    });

    it('round-trips a versioned encrypted pairing payload', () => {
        const encoded = encodeAuthPairingPayload({
            version: 2,
            token: 'token-value',
            rpcRegistrationToken: 'rpc-registration-token',
            response: 'ZW5jcnlwdGVk',
        });

        expect(decodeAuthPairingPayload(encoded)).toEqual({
            version: 2,
            token: 'token-value',
            rpcRegistrationToken: 'rpc-registration-token',
            response: 'ZW5jcnlwdGVk',
        });
    });

    it('rejects malformed or unsupported pairing payloads', () => {
        expect(decodeAuthPairingPayload(new TextEncoder().encode('not-json'))).toBeNull();
        expect(decodeAuthPairingPayload(new TextEncoder().encode(JSON.stringify({
            version: 1,
            token: 'token-value',
            response: 'ZW5jcnlwdGVk',
        })))).toBeNull();
    });

    it('binds account pairing approval to the relay, requester, account, bearer, and secret', () => {
        const message = new TextDecoder().decode(buildAccountPairingMessage({
            type: 'idle-account-pairing',
            version: 3,
            relayAudience: 'https://IDLE.TEST:443',
            requesterPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            accountPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            token: 'bearer-token',
            secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
        }));

        expect(message).toBe(JSON.stringify({
            type: 'idle-account-pairing',
            version: 3,
            relayAudience: 'https://idle.test',
            requesterPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            accountPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            token: 'bearer-token',
            secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
        }));

        const changedAudience = buildAccountPairingMessage({
            type: 'idle-account-pairing',
            version: 3,
            relayAudience: 'https://other.test',
            requesterPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            accountPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            token: 'bearer-token',
            secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
        });
        expect(changedAudience).not.toEqual(new TextEncoder().encode(message));
    });

    it('round-trips only strict canonical account pairing v3 payloads', () => {
        const encoded = encodeAccountPairingPayload({
            type: 'idle-account-pairing',
            version: 3,
            relayAudience: 'https://IDLE.TEST:443',
            requesterPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            accountPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            token: 'bearer-token',
            secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
            signature: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA==',
        });

        expect(decodeAccountPairingPayload(encoded)).toEqual({
            type: 'idle-account-pairing',
            version: 3,
            relayAudience: 'https://idle.test',
            requesterPublicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
            accountPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=',
            token: 'bearer-token',
            secret: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=',
            signature: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA==',
        });

        const parsed = JSON.parse(new TextDecoder().decode(encoded));
        expect(decodeAccountPairingPayload(new TextEncoder().encode(JSON.stringify({
            ...parsed,
            version: 2,
        })))).toBeNull();
        expect(decodeAccountPairingPayload(new TextEncoder().encode(JSON.stringify({
            ...parsed,
            relayAudience: 'https://IDLE.TEST:443',
        })))).toBeNull();
        expect(decodeAccountPairingPayload(new TextEncoder().encode(JSON.stringify({
            ...parsed,
            extra: true,
        })))).toBeNull();
        expect(decodeAccountPairingPayload(new TextEncoder().encode(JSON.stringify({
            ...parsed,
            requesterPublicKey: `${parsed.requesterPublicKey.slice(0, -2)}F=`,
        })))).toBeNull();
        expect(decodeAccountPairingPayload(new TextEncoder().encode(JSON.stringify({
            ...parsed,
            signature: `${parsed.signature.slice(0, -3)}B==`,
        })))).toBeNull();
    });

    it('derives a readable 48-bit account-pairing verification code', () => {
        expect(formatAccountPairingCode(new Uint8Array([0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78])))
            .toBe('ABCD-EF12-3456');
        expect(() => formatAccountPairingCode(new Uint8Array(5))).toThrow(/six bytes/i);
    });
});
