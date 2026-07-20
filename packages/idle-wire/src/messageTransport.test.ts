import { describe, expect, it } from 'vitest';

import {
    MAX_MESSAGE_INGRESS_BODY_BYTES,
    splitMessageIngressBatches,
} from './messageTransport';

describe('message ingress transport budget', () => {
    it('splits batches without changing order or exceeding the encoded body ceiling', () => {
        const messages = Array.from({ length: 5 }, (_, index) => ({
            localId: `message-${index}`,
            content: 'x'.repeat(64),
        }));
        const batches = splitMessageIngressBatches(messages, 220, 100);

        expect(batches.flat()).toEqual(messages);
        expect(batches.length).toBeGreaterThan(1);
        for (const batch of batches) {
            expect(new TextEncoder().encode(JSON.stringify({ messages: batch })).byteLength)
                .toBeLessThanOrEqual(220);
        }
    });

    it('rejects an individually oversized item instead of emitting an invalid request', () => {
        expect(() => splitMessageIngressBatches([
            { localId: 'message-1', content: 'x'.repeat(1_000) },
        ], 100, 100)).toThrow('Message exceeds the ingress body limit');
    });

    it('publishes a ceiling large enough for one maximum encrypted message envelope', () => {
        const maximumCiphertextCharacters = Math.ceil(4 * 1024 * 1024 / 3) * 4;
        const bytes = new TextEncoder().encode(JSON.stringify({
            messages: [{ localId: 'x'.repeat(64), content: 'x'.repeat(maximumCiphertextCharacters) }],
        })).byteLength;

        expect(bytes).toBeLessThan(MAX_MESSAGE_INGRESS_BODY_BYTES);
    });
});
