import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { consumeSocketHandshakeAuth } from './socketHandshakeAuth';

describe('Socket.IO handshake credential lifecycle', () => {
    it('consumes only allowlisted admission fields and clears the serializable handshake', () => {
        const marker = 'fixed-test-bearer-marker';
        const socket = {
            handshake: {
                auth: {
                    token: marker,
                    clientType: 'user-scoped',
                    happyClient: 'idle-app/1.2.3',
                    appState: 'active',
                    futureCredentialAdjacentField: marker,
                },
                headers: {},
            },
        };

        const consumed = consumeSocketHandshakeAuth(socket);

        expect(consumed).toEqual({
            token: marker,
            clientType: 'user-scoped',
            sessionId: undefined,
            machineId: undefined,
            happyClient: 'idle-app/1.2.3',
            appState: 'active',
        });
        expect(socket.handshake.auth).toEqual({});

        const modeledRemoteDescriptor = {
            handshake: socket.handshake,
            data: { clientType: 'user-scoped', appState: 'active' },
        };
        expect(JSON.stringify(modeledRemoteDescriptor)).not.toContain(marker);
    });

    it('consumes handshake auth before asynchronous admission and never rereads it', async () => {
        const source = await readFile(new URL('../socket.ts', import.meta.url), 'utf8');
        const consumeAt = source.indexOf('consumeSocketHandshakeAuth(socket)');
        const admissionAt = source.indexOf('await prepareSocketAdmission({');

        expect(consumeAt).toBeGreaterThanOrEqual(0);
        expect(admissionAt).toBeGreaterThan(consumeAt);
        expect(source).not.toContain('socket.handshake.auth.');
    });
});
