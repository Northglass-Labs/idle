import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
    decodeBase64,
    decrypt,
    encodeBase64,
    encrypt,
    getRandomBytes,
} from './encryption';
import type { EncryptionVariant } from './api';
import { createAuthenticatedSessionFieldEnvelope } from '@northglass/idle-wire';

// --- Mock socket.io-client ---

class MockSocket extends EventEmitter {
    connected = true;
    readonly auth: unknown;
    readonly opts: unknown;

    emittedEvents: Array<{ event: string; args: unknown[] }> = [];

    constructor(url: string, opts: unknown) {
        super();
        this.opts = opts;
        this.auth = (opts as Record<string, unknown>).auth;
    }

    connect() {
        this.connected = true;
        // Emit connect asynchronously to allow test setup
        setTimeout(() => this.emit('connect'), 0);
    }

    close() {
        this.connected = false;
        this.emit('disconnect', 'client namespace disconnect');
    }

    // Override emit to track emitted events (but still call EventEmitter's emit for listeners)
    override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (typeof event === 'string' && event !== 'connect' && event !== 'disconnect' && event !== 'connect_error' && event !== 'update') {
            this.emittedEvents.push({ event: event as string, args });
        }
        return super.emit(event, ...args);
    }

    // Simulate receiving a server event
    simulateServerEvent(event: string, data: unknown) {
        // Use EventEmitter's emit directly
        super.emit(event, data);
    }
}

let mockSocketInstance: MockSocket | null = null;

vi.mock('socket.io-client', () => ({
    io: vi.fn((url: string, opts: unknown) => {
        mockSocketInstance = new MockSocket(url, opts);
        return mockSocketInstance;
    }),
}));

import { SessionClient, SessionClientOptions } from './session';

// --- Test helpers ---

function makeSessionKey(): Uint8Array {
    return getRandomBytes(32);
}

function makeOptions(overrides: Partial<SessionClientOptions> = {}): SessionClientOptions {
    return {
        sessionId: 'test-session-id',
        encryptionKey: makeSessionKey(),
        encryptionVariant: 'dataKey' as EncryptionVariant,
        token: 'test-jwt-token',
        serverUrl: 'https://test-server.example.com',
        ...overrides,
    };
}

function makeEncryptedUpdate(
    key: Uint8Array,
    variant: EncryptionVariant,
    content: unknown,
    sessionId: string,
    overrides: Partial<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }> = {},
) {
    const encrypted = encodeBase64(encrypt(key, variant, content));
    return {
        id: overrides.id ?? 'update-1',
        seq: overrides.seq ?? 1,
        body: {
            t: 'new-message' as const,
            sid: sessionId,
            message: {
                id: overrides.id ?? 'msg-1',
                seq: overrides.seq ?? 1,
                content: { t: 'encrypted' as const, c: encrypted },
                localId: overrides.localId ?? null,
                createdAt: overrides.createdAt ?? 1000,
                updatedAt: overrides.updatedAt ?? 1000,
            },
        },
        createdAt: Date.now(),
    };
}

function makeSessionUpdate(
    key: Uint8Array,
    variant: EncryptionVariant,
    sessionId: string,
    opts: {
        metadata?: { data: unknown; version: number };
        agentState?: { data: unknown | null; version: number };
    },
) {
    return {
        id: 'update-session-1',
        seq: 1,
        body: {
            t: 'update-session' as const,
            id: sessionId,
            metadata: opts.metadata
                ? {
                      value: encodeBase64(encrypt(
                          key,
                          variant,
                          createAuthenticatedSessionFieldEnvelope(
                              sessionId,
                              'metadata',
                              opts.metadata.version,
                              opts.metadata.data as Record<string, unknown>,
                          ),
                      )),
                      version: opts.metadata.version,
                  }
                : undefined,
            agentState: opts.agentState
                ? {
                      value:
                          opts.agentState.data !== null
                              ? encodeBase64(encrypt(
                                  key,
                                  variant,
                                  createAuthenticatedSessionFieldEnvelope(
                                      sessionId,
                                      'agentState',
                                      opts.agentState.version,
                                      opts.agentState.data as Record<string, unknown>,
                                  ),
                              ))
                              : null,
                      version: opts.agentState.version,
                  }
                : undefined,
        },
        createdAt: Date.now(),
    };
}

// --- Tests ---

describe('SessionClient', () => {
    beforeEach(() => {
        mockSocketInstance = null;
        vi.clearAllMocks();
    });

    afterEach(() => {
        mockSocketInstance = null;
    });

    describe('constructor and connection', () => {
        it('creates socket with correct auth parameters', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            expect(mockSocketInstance).not.toBeNull();
            const socketOpts = mockSocketInstance!.opts as Record<string, unknown>;
            const auth = socketOpts.auth as Record<string, unknown>;
            expect(auth.token).toBe('test-jwt-token');
            expect(auth.clientType).toBe('session-scoped');
            expect(auth.sessionId).toBe('test-session-id');
            expect(socketOpts.path).toBe('/v1/updates');

            client.close();
        });

        it('connects to the correct server URL', async () => {
            const { io: mockIo } = vi.mocked(await import('socket.io-client'));
            const opts = makeOptions({ serverUrl: 'https://custom-server.example.com' });
            const client = new SessionClient(opts);

            expect(mockIo).toHaveBeenCalledWith(
                'https://custom-server.example.com',
                expect.objectContaining({
                    path: '/v1/updates',
                    transports: ['websocket'],
                }),
            );

            client.close();
        });

        it('emits connected event when socket connects', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const connected = new Promise<void>((resolve) => {
                client.on('connected', resolve);
            });

            // The mock socket emits connect asynchronously from connect()
            await connected;

            client.close();
        });

        it('emits disconnected event when socket disconnects', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const disconnected = new Promise<string>((resolve) => {
                client.on('disconnected', resolve);
            });

            client.close();

            const reason = await disconnected;
            expect(reason).toBe('client namespace disconnect');
        });
    });

    describe('sendMessage', () => {
        it('encrypts and sends a user message', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            client.sendMessage('Hello agent');

            // Find the 'message' event in emitted events
            const messageEvents = mockSocketInstance!.emittedEvents.filter(
                (e) => e.event === 'message',
            );
            expect(messageEvents).toHaveLength(1);

            const data = messageEvents[0].args[0] as { sid: string; message: string; localId?: string };
            expect(data.sid).toBe('test-session-id');
            expect(typeof data.message).toBe('string'); // base64-encoded encrypted content
            expect(data.localId).toMatch(/^[0-9a-f-]{36}$/i);

            client.close();
        });

        it('message can be decrypted to original content', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            client.sendMessage('Test message text');

            const messageEvents = mockSocketInstance!.emittedEvents.filter(
                (e) => e.event === 'message',
            );
            const data = messageEvents[0].args[0] as { sid: string; message: string; localId: string };

            const decrypted = decrypt(
                opts.encryptionKey,
                opts.encryptionVariant,
                decodeBase64(data.message),
            ) as Record<string, unknown>;

            expect(decrypted.role).toBe('user');
            expect((decrypted.content as Record<string, unknown>).type).toBe('text');
            expect((decrypted.content as Record<string, unknown>).text).toBe('Test message text');
            expect((decrypted.meta as Record<string, unknown>).sentFrom).toBe('idle-agent');
            expect(decrypted.messageIdentity).toEqual({
                v: 1,
                sessionId: 'test-session-id',
                messageId: data.localId,
            });

            client.close();
        });

        it('includes custom meta in the message', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            client.sendMessage('Hello', { customField: 'value' });

            const messageEvents = mockSocketInstance!.emittedEvents.filter(
                (e) => e.event === 'message',
            );
            const data = messageEvents[0].args[0] as { sid: string; message: string };
            const decrypted = decrypt(
                opts.encryptionKey,
                opts.encryptionVariant,
                decodeBase64(data.message),
            ) as Record<string, unknown>;
            const meta = decrypted.meta as Record<string, unknown>;
            expect(meta.sentFrom).toBe('idle-agent');
            expect(meta.customField).toBe('value');

            client.close();
        });

        it('works with legacy encryption variant', () => {
            const opts = makeOptions({ encryptionVariant: 'legacy' });
            const client = new SessionClient(opts);

            client.sendMessage('Legacy message');

            const messageEvents = mockSocketInstance!.emittedEvents.filter(
                (e) => e.event === 'message',
            );
            const data = messageEvents[0].args[0] as { sid: string; message: string };
            const decrypted = decrypt(
                opts.encryptionKey,
                opts.encryptionVariant,
                decodeBase64(data.message),
            ) as Record<string, unknown>;

            expect(decrypted.role).toBe('user');
            expect((decrypted.content as Record<string, unknown>).text).toBe('Legacy message');

            client.close();
        });
    });

    describe('update event handling and decryption', () => {
        it('decrypts and emits new-message updates', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const messageContent = { role: 'assistant', text: 'Hello from agent' };

            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));

            const update = makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                messageContent,
                opts.sessionId,
            );
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(messages).toHaveLength(1);
            const msg = messages[0] as Record<string, unknown>;
            expect(msg.id).toBe('msg-1');
            expect(msg.content).toEqual(messageContent);
            expect(msg.createdAt).toBe(1000);

            client.close();
        });

        it('rejects replayed, out-of-order, and cross-session message updates', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));

            const accepted = makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', text: 'accepted' },
                opts.sessionId,
                { id: 'accepted', seq: 2 },
            );
            mockSocketInstance!.simulateServerEvent('update', accepted);
            mockSocketInstance!.simulateServerEvent('update', accepted);
            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', text: 'older' },
                opts.sessionId,
                { id: 'older', seq: 1 },
            ));
            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', text: 'wrong session' },
                'another-session',
                { id: 'wrong-session', seq: 3 },
            ));

            expect(messages).toHaveLength(1);
            expect((messages[0] as { content: unknown }).content).toEqual({
                role: 'assistant',
                text: 'accepted',
            });

            client.close();
        });

        it('rejects an invalid live-update envelope before decryption', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const messages: unknown[] = [];
            client.on('message', message => messages.push(message));

            const update = makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', text: 'must not be accepted' },
                opts.sessionId,
            );
            update.id = 'x'.repeat(129);
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(messages).toEqual([]);
            client.close();
        });

        it('does not consume a message sequence number when decryption fails', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));

            mockSocketInstance!.simulateServerEvent('update', {
                id: 'bad-update',
                seq: 1,
                body: {
                    t: 'new-message',
                    sid: opts.sessionId,
                    message: {
                        id: 'bad-message',
                        seq: 1,
                        content: { t: 'encrypted', c: 'AAAA' },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                },
                createdAt: Date.now(),
            });
            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', text: 'retry' },
                opts.sessionId,
                { id: 'retry', seq: 1 },
            ));

            expect(messages).toHaveLength(1);
            expect((messages[0] as { content: unknown }).content).toEqual({
                role: 'assistant',
                text: 'retry',
            });

            client.close();
        });

        it('decrypts and caches metadata updates', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const metadata = { path: '/home/user/project', host: 'laptop' };

            const stateChanges: unknown[] = [];
            client.on('state-change', (data) => stateChanges.push(data));

            const update = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                metadata: { data: metadata, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(stateChanges).toHaveLength(1);
            expect(client.getMetadata()).toEqual(metadata);

            client.close();
        });

        it('decrypts and caches agentState updates', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const agentState = { controlledByUser: true, requests: { 'req-1': { tool: 'test', arguments: {}, createdAt: Date.now() } } };

            const stateChanges: unknown[] = [];
            client.on('state-change', (data) => stateChanges.push(data));

            const update = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: agentState, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(stateChanges).toHaveLength(1);
            expect(client.getAgentState()).toEqual(agentState);

            client.close();
        });

        it('rejects a captured state ciphertext relabeled to a newer outer version after restart', () => {
            const opts = makeOptions({
                initialAgentState: { controlledByUser: true, requests: {} },
                initialAgentStateVersion: 0,
            });
            const captured = makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    agentState: {
                        data: {
                            controlledByUser: false,
                            requests: {
                                captured: { tool: 'Bash', arguments: { command: 'pwd' } },
                            },
                        },
                        version: 1,
                    },
                },
            );
            const capturedValue = captured.body.agentState!.value;

            // A new client has empty replay sets, matching a process restart.
            const freshClient = new SessionClient(opts);
            const stateChanges: unknown[] = [];
            freshClient.on('state-change', (data) => stateChanges.push(data));

            mockSocketInstance!.simulateServerEvent('update', {
                ...captured,
                id: 'rewrapped-after-restart',
                body: {
                    ...captured.body,
                    agentState: { value: capturedValue, version: 999 },
                },
            });

            expect(freshClient.getAgentState()).toEqual({
                controlledByUser: true,
                requests: {},
            });
            expect(stateChanges).toEqual([]);
            freshClient.close();
        });

        it('ignores metadata updates with lower version', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // Set initial metadata at version 5
            const update1 = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                metadata: { data: { path: '/v5' }, version: 5 },
            });
            mockSocketInstance!.simulateServerEvent('update', update1);
            expect(client.getMetadata()).toEqual({ path: '/v5' });

            // Try to set metadata at version 3 (lower) — should be ignored
            const update2 = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                metadata: { data: { path: '/v3' }, version: 3 },
            });
            mockSocketInstance!.simulateServerEvent('update', update2);
            expect(client.getMetadata()).toEqual({ path: '/v5' });

            client.close();
        });

        it('ignores agentState updates with lower version', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const update1 = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: true, requests: {} }, version: 3 },
            });
            mockSocketInstance!.simulateServerEvent('update', update1);

            const update2 = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: false, requests: {} }, version: 2 },
            });
            mockSocketInstance!.simulateServerEvent('update', update2);

            const state = client.getAgentState() as Record<string, unknown>;
            expect(state.controlledByUser).toBe(true);

            client.close();
        });

        it('handles null agentState value', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const update = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: null, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(client.getAgentState()).toBeNull();

            client.close();
        });

        it('handles update with both metadata and agentState', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const metadata = { path: '/project' };
            const agentState = { controlledByUser: false, requests: {} };

            const update = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                metadata: { data: metadata, version: 1 },
                agentState: { data: agentState, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(client.getMetadata()).toEqual(metadata);
            expect(client.getAgentState()).toEqual(agentState);

            client.close();
        });

        it('silently ignores updates with no body', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));
            client.on('state-change', (data) => messages.push(data));

            mockSocketInstance!.simulateServerEvent('update', { id: '1', seq: 1, body: null, createdAt: Date.now() });

            expect(messages).toHaveLength(0);

            client.close();
        });

        it('handles decryption errors silently', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));

            // Send an update with garbage encrypted data
            const update = {
                id: 'bad-update',
                seq: 1,
                body: {
                    t: 'new-message',
                    sid: opts.sessionId,
                    message: {
                        id: 'msg-bad',
                        seq: 1,
                        content: { t: 'encrypted', c: 'not-valid-encrypted-data' },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                },
                createdAt: Date.now(),
            };
            mockSocketInstance!.simulateServerEvent('update', update);

            // Should not crash, and no message should be emitted (decryption fails)
            expect(messages).toHaveLength(0);

            client.close();
        });

        it('does not advance state versions or emit state changes after failed decryption', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const stateChanges: unknown[] = [];
            client.on('state-change', (data) => stateChanges.push(data));

            mockSocketInstance!.simulateServerEvent('update', {
                id: 'bad-state-update',
                seq: 1,
                body: {
                    t: 'update-session',
                    id: opts.sessionId,
                    metadata: { value: 'AAAA', version: 2 },
                    agentState: { value: 'AAAA', version: 2 },
                },
                createdAt: Date.now(),
            });
            mockSocketInstance!.simulateServerEvent('update', makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    metadata: { data: { path: '/valid' }, version: 2 },
                    agentState: {
                        data: { controlledByUser: false, requests: {} },
                        version: 2,
                    },
                },
            ));

            expect(stateChanges).toHaveLength(1);
            expect(client.getMetadata()).toEqual({ path: '/valid' });
            expect(client.getAgentState()).toEqual({ controlledByUser: false, requests: {} });

            client.close();
        });

        it('works with legacy encryption for updates', () => {
            const opts = makeOptions({ encryptionVariant: 'legacy' });
            const client = new SessionClient(opts);
            const messageContent = { role: 'assistant', text: 'Legacy response' };

            const messages: unknown[] = [];
            client.on('message', (msg) => messages.push(msg));

            const update = makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                messageContent,
                opts.sessionId,
            );
            mockSocketInstance!.simulateServerEvent('update', update);

            expect(messages).toHaveLength(1);
            expect((messages[0] as Record<string, unknown>).content).toEqual(messageContent);

            client.close();
        });
    });

    describe('waitForIdle', () => {
        it('does not resolve immediately when no agentState is set', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // With null agentState, waitForIdle should not resolve (no state = not known to be idle)
            await expect(client.waitForIdle(100)).rejects.toThrow(
                'Timeout waiting for agent to become idle',
            );

            client.close();
        });

        it('resolves when controlledByUser becomes false and no requests', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // Set initial state as busy
            const busyUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: true, requests: { 'r1': { tool: 'test', arguments: {}, createdAt: Date.now() } } }, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', busyUpdate);

            // Start waiting for idle
            const idlePromise = client.waitForIdle(5000);

            // Transition to idle
            const idleUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: false, requests: {} }, version: 2 },
            });
            mockSocketInstance!.simulateServerEvent('update', idleUpdate);

            await idlePromise;
            // Should resolve without error

            client.close();
        });

        it('does not resolve when agentState becomes null', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // Set initial state as busy
            const busyUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: true, requests: {} }, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', busyUpdate);

            // Set agentState to null -- null is not considered idle
            const nullUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: null, version: 2 },
            });
            mockSocketInstance!.simulateServerEvent('update', nullUpdate);

            await expect(client.waitForIdle(200)).rejects.toThrow(
                'Timeout waiting for agent to become idle',
            );

            client.close();
        });

        it('does not resolve when only controlledByUser is false but requests remain', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const busyUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: true, requests: { 'r1': { tool: 'test', arguments: {}, createdAt: Date.now() } } }, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', busyUpdate);

            let resolved = false;
            const idlePromise = client.waitForIdle(500).then(() => {
                resolved = true;
            });

            // Only change controlledByUser, keep requests
            const partialUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: false, requests: { 'r1': { tool: 'test', arguments: {}, createdAt: Date.now() } } }, version: 2 },
            });
            mockSocketInstance!.simulateServerEvent('update', partialUpdate);

            // Wait a bit to check it hasn't resolved
            await new Promise((r) => setTimeout(r, 100));
            expect(resolved).toBe(false);

            // Now clear requests
            const fullyIdleUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: false, requests: {} }, version: 3 },
            });
            mockSocketInstance!.simulateServerEvent('update', fullyIdleUpdate);

            await idlePromise;
            expect(resolved).toBe(true);

            client.close();
        });

        it('rejects on timeout', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // Set busy state
            const busyUpdate = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: true, requests: {} }, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', busyUpdate);

            await expect(client.waitForIdle(100)).rejects.toThrow(
                'Timeout waiting for agent to become idle',
            );

            client.close();
        });

        it('considers undefined requests as idle', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            // Set state with controlledByUser false and no requests field
            const update = makeSessionUpdate(opts.encryptionKey, opts.encryptionVariant, opts.sessionId, {
                agentState: { data: { controlledByUser: false }, version: 1 },
            });
            mockSocketInstance!.simulateServerEvent('update', update);

            // Should resolve since controlledByUser is false and requests is undefined (idle)
            await client.waitForIdle(1000);

            client.close();
        });
    });

    describe('waitForTurnCompletion', () => {
        it('does not emit a message when send-and-wait starts on an archived session', async () => {
            const client = new SessionClient(makeOptions({
                initialMetadata: { lifecycleState: 'archived' },
            }));

            await expect(client.sendMessageAndWait('Do not send this', undefined, 1000))
                .rejects.toThrow('Session was archived while waiting for agent turn completion');
            expect(
                mockSocketInstance!.emittedEvents.filter((event) => event.event === 'message'),
            ).toHaveLength(0);
            client.close();
        });

        it('rejects immediately when the session is already archived', async () => {
            const client = new SessionClient(makeOptions({
                initialMetadata: { lifecycleState: 'archived' },
            }));

            await expect(client.waitForTurnCompletion('expected-request', 1000))
                .rejects.toThrow('Session was archived while waiting for agent turn completion');
            client.close();
        });

        it('rejects when the session is archived while waiting for a turn', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const completion = client.waitForTurnCompletion('expected-request', 1000);

            mockSocketInstance!.simulateServerEvent('update', makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    metadata: {
                        data: { lifecycleState: 'archived' },
                        version: 1,
                    },
                },
            ));

            await expect(completion).rejects.toThrow('Session was archived while waiting for agent turn completion');
            client.close();
        });

        it('binds send-and-wait completion to the sender-owned message identity', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            let resolved = false;

            const completion = client.sendMessageAndWait('Run the requested task', undefined, 1000)
                .then(() => {
                    resolved = true;
                });
            const outbound = mockSocketInstance!.emittedEvents.find(
                (event) => event.event === 'message',
            )?.args[0] as { localId: string };

            for (const [seq, event] of [
                [1, { t: 'turn-start' }],
                [2, { t: 'turn-end', status: 'completed' }],
            ] as const) {
                mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                    opts.encryptionKey,
                    opts.encryptionVariant,
                    {
                        role: 'session',
                        requestId: 'captured-older-request',
                        content: {
                            turn: 'captured-older-turn',
                            ev: event,
                        },
                    },
                    opts.sessionId,
                    { id: `captured-${seq}`, seq },
                ));
            }

            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(resolved).toBe(false);

            for (const [seq, event] of [
                [3, { t: 'turn-start' }],
                [4, { t: 'turn-end', status: 'completed' }],
            ] as const) {
                mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                    opts.encryptionKey,
                    opts.encryptionVariant,
                    {
                        role: 'session',
                        requestId: outbound.localId,
                        content: {
                            turn: 'fresh-correlated-turn',
                            ev: event,
                        },
                    },
                    opts.sessionId,
                    { id: `fresh-${seq}`, seq },
                ));
            }

            await completion;
            expect(resolved).toBe(true);
            client.close();
        });

        it('does not resolve from a fresh turn-end without a post-wait turn-start', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const completion = client.waitForTurnCompletion('expected-request', 100);

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    content: {
                        turn: 'unrelated-turn',
                        ev: { t: 'turn-end', status: 'completed' },
                    },
                },
                opts.sessionId,
                { id: 'unseen-turn-end', seq: 1 },
            ));

            await expect(completion).rejects.toThrow('Timeout waiting for agent turn completion');
            client.close();
        });

        it('does not treat an exact replay of an already-observed turn-end as new completion', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const oldTurnEnd = makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    content: {
                        turn: 'old-turn',
                        ev: { t: 'turn-end', status: 'completed' },
                    },
                },
                opts.sessionId,
                { id: 'old-turn-end', seq: 1 },
            );

            mockSocketInstance!.simulateServerEvent('update', oldTurnEnd);
            const completion = client.waitForTurnCompletion('expected-request', 100);
            mockSocketInstance!.simulateServerEvent('update', oldTurnEnd);

            await expect(completion).rejects.toThrow('Timeout waiting for agent turn completion');
            client.close();
        });

        it('does not resolve from a rewrapped equal-version idle-state replay', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);
            const idleState = makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                { agentState: { data: { controlledByUser: false, requests: {} }, version: 1 } },
            );
            mockSocketInstance!.simulateServerEvent('update', idleState);

            const completion = client.waitForTurnCompletion('expected-request', 100);
            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                { role: 'assistant', content: { type: 'text', text: 'new work' } },
                opts.sessionId,
                { id: 'new-work', seq: 2 },
            ));
            mockSocketInstance!.simulateServerEvent('update', {
                ...idleState,
                id: 'rewrapped-idle-state',
                seq: 3,
            });

            await expect(completion).rejects.toThrow('Timeout waiting for agent turn completion');
            client.close();
        });

        it('resolves when a turn-end arrives after turn-start', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const completion = client.waitForTurnCompletion('expected-request', 1000);

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    requestId: 'expected-request',
                    content: {
                        turn: 'turn-1',
                        ev: { t: 'turn-start' },
                    },
                },
                opts.sessionId,
                { seq: 1 },
            ));

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    requestId: 'expected-request',
                    content: {
                        turn: 'turn-1',
                        ev: { t: 'turn-end', status: 'completed' },
                    },
                },
                opts.sessionId,
                { seq: 2 },
            ));

            await completion;

            client.close();
        });

        it('resolves on ready events emitted after post-send agent activity', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const completion = client.waitForTurnCompletion('expected-request', 1000);

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    requestId: 'expected-request',
                    content: {
                        ev: { t: 'text', text: 'Thinking...' },
                    },
                },
                opts.sessionId,
                { seq: 1 },
            ));

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'agent',
                    requestId: 'expected-request',
                    content: {
                        type: 'event',
                        data: { type: 'ready' },
                    },
                },
                opts.sessionId,
                { seq: 2 },
            ));

            await completion;

            client.close();
        });

        it('does not resolve on idle state changes before any post-send activity', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const completion = client.waitForTurnCompletion('expected-request', 100);

            mockSocketInstance!.simulateServerEvent('update', makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    agentState: { data: { controlledByUser: false, requests: {} }, version: 1 },
                },
            ));

            await expect(completion).rejects.toThrow('Timeout waiting for agent turn completion');

            client.close();
        });

        it('does not use uncorrelated idle state as a completion signal', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const completion = client.waitForTurnCompletion('expected-request', 100);

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'assistant',
                    requestId: 'expected-request',
                    content: {
                        type: 'text',
                        text: 'Working on it',
                    },
                },
                opts.sessionId,
                { seq: 1 },
            ));

            mockSocketInstance!.simulateServerEvent('update', makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    agentState: { data: { controlledByUser: false, requests: {} }, version: 1 },
                },
            ));

            await expect(completion).rejects.toThrow('Timeout waiting for agent turn completion');

            client.close();
        });

        it('does not resolve from idle state once a turn has started', async () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            let resolved = false;
            const completion = client.waitForTurnCompletion('expected-request', 1000).then(() => {
                resolved = true;
            });

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    requestId: 'expected-request',
                    content: {
                        turn: 'turn-2',
                        ev: { t: 'turn-start' },
                    },
                },
                opts.sessionId,
                { seq: 1 },
            ));

            mockSocketInstance!.simulateServerEvent('update', makeSessionUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                opts.sessionId,
                {
                    agentState: { data: { controlledByUser: false, requests: {} }, version: 1 },
                },
            ));

            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(resolved).toBe(false);

            mockSocketInstance!.simulateServerEvent('update', makeEncryptedUpdate(
                opts.encryptionKey,
                opts.encryptionVariant,
                {
                    role: 'session',
                    requestId: 'expected-request',
                    content: {
                        turn: 'turn-2',
                        ev: { t: 'turn-end', status: 'completed' },
                    },
                },
                opts.sessionId,
                { seq: 2 },
            ));

            await completion;
            expect(resolved).toBe(true);

            client.close();
        });
    });

    describe('sendStop', () => {
        it('emits session-end event with session ID and time', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            const now = Date.now();
            client.sendStop();

            const endEvents = mockSocketInstance!.emittedEvents.filter(
                (e) => e.event === 'session-end',
            );
            expect(endEvents).toHaveLength(1);

            const data = endEvents[0].args[0] as { sid: string; time: number };
            expect(data.sid).toBe('test-session-id');
            expect(data.time).toBeGreaterThanOrEqual(now);
            expect(data.time).toBeLessThanOrEqual(Date.now());

            client.close();
        });
    });

    describe('close', () => {
        it('disconnects the socket', () => {
            const opts = makeOptions();
            const client = new SessionClient(opts);

            expect(mockSocketInstance!.connected).toBe(true);
            client.close();
            expect(mockSocketInstance!.connected).toBe(false);
        });
    });
});
