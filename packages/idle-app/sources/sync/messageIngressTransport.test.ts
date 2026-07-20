import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_INGRESS_BODY_BYTES } from '@northglass/idle-wire';

import { selectNextMessageIngressBatch } from './messageIngressTransport';

describe('selectNextMessageIngressBatch', () => {
    it('selects the oldest bounded batch and excludes local retry metadata', () => {
        const content = 'x'.repeat(Math.floor(MAX_MESSAGE_INGRESS_BODY_BYTES * 0.55));
        const batch = selectNextMessageIngressBatch([
            { localId: 'oldest', content, plaintext: 'local only' },
            { localId: 'newest', content, plaintext: 'local only' },
        ]);

        expect(batch).toEqual([{ localId: 'oldest', content }]);
        expect(new TextEncoder().encode(JSON.stringify({ messages: batch })).byteLength)
            .toBeLessThanOrEqual(MAX_MESSAGE_INGRESS_BODY_BYTES);
    });
});
