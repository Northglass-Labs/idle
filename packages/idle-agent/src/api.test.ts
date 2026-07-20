import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    encodeBase64,
    decodeBase64,
    getRandomBytes,
    encryptWithDataKey,
    encryptLegacy,
    libsodiumEncryptForPublicKey,
    deriveContentKeyPair,
} from './encryption';
import type { Config } from './config';
import type { Credentials } from './credentials';
import type { RawSession, RawMessage } from './api';

// Mock axios
vi.mock('axios', () => {
    const fn = {
        get: vi.fn(),
        post: vi.fn(),
        delete: vi.fn(),
    };
    return {
        default: fn,
        AxiosError: class AxiosError extends Error {
            response?: { status: number; data?: unknown };
            constructor(message: string, opts?: { response?: { status: number; data?: unknown } }) {
                super(message);
                this.name = 'AxiosError';
                this.response = opts?.response;
            }
        },
    };
});

import axios from 'axios';
import {
    listSessions,
    listMachines,
    listActiveSessions,
    createSession,
    deleteSession,
    getSessionMessages,
    resolveSessionEncryption,
} from './api';

const authHeader = {
    Authorization: 'Bearer test-jwt-token',
    'X-Happy-Client': 'cli-control-plane/0.1.0',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAxios = axios as any as {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
};

// --- Test helpers ---

function makeConfig(): Config {
    return {
        serverUrl: 'https://test-server.example.com',
        homeDir: '/tmp/idle-test',
        credentialPath: '/tmp/idle-test/agent.key',
    };
}

function makeCredentials(): Credentials {
    const secret = getRandomBytes(32);
    const contentKeyPair = deriveContentKeyPair(secret);
    return {
        token: 'test-jwt-token',
        secret,
        accountPublicKey: tweetnacl.sign.keyPair.fromSeed(secret).publicKey,
        relayAudience: 'https://test-server.example.com',
        contentKeyPair,
    };
}

function makeRawSessionWithDataKey(
    creds: Credentials,
    metadata: unknown,
    agentState: unknown | null = null,
    overrides: Partial<RawSession> = {},
): { raw: RawSession; sessionKey: Uint8Array } {
    const sessionKey = getRandomBytes(32);

    // Encrypt session key with content public key and prepend version byte
    const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey);
    const withVersion = new Uint8Array(1 + encryptedKey.length);
    withVersion[0] = 0x00;
    withVersion.set(encryptedKey, 1);

    // Encrypt metadata and agentState with session key
    const encryptedMetadata = encryptWithDataKey(metadata, sessionKey);
    const encryptedAgentState = agentState ? encryptWithDataKey(agentState, sessionKey) : null;

    const raw: RawSession = {
        id: overrides.id ?? 'session-abc123',
        seq: overrides.seq ?? 1,
        createdAt: overrides.createdAt ?? Date.now(),
        updatedAt: overrides.updatedAt ?? Date.now(),
        active: overrides.active ?? true,
        activeAt: overrides.activeAt ?? Date.now(),
        metadata: encodeBase64(encryptedMetadata),
        metadataVersion: overrides.metadataVersion ?? 1,
        agentState: encryptedAgentState ? encodeBase64(encryptedAgentState) : null,
        agentStateVersion: overrides.agentStateVersion ?? 0,
        dataEncryptionKey: encodeBase64(withVersion),
        ...('dataEncryptionKey' in overrides ? { dataEncryptionKey: overrides.dataEncryptionKey } : {}),
    };

    return { raw, sessionKey };
}

function makeRawSessionLegacy(
    creds: Credentials,
    metadata: unknown,
    agentState: unknown | null = null,
    overrides: Partial<RawSession> = {},
): RawSession {
    const encryptedMetadata = encryptLegacy(metadata, creds.secret);
    const encryptedAgentState = agentState ? encryptLegacy(agentState, creds.secret) : null;

    return {
        id: overrides.id ?? 'session-legacy-456',
        seq: overrides.seq ?? 1,
        createdAt: overrides.createdAt ?? Date.now(),
        updatedAt: overrides.updatedAt ?? Date.now(),
        active: overrides.active ?? true,
        activeAt: overrides.activeAt ?? Date.now(),
        metadata: encodeBase64(encryptedMetadata),
        metadataVersion: overrides.metadataVersion ?? 1,
        agentState: encryptedAgentState ? encodeBase64(encryptedAgentState) : null,
        agentStateVersion: overrides.agentStateVersion ?? 0,
        dataEncryptionKey: null,
    };
}

function rawHistoryMessage(
    id: string,
    seq: number,
    localId: string | null,
    ciphertext: Uint8Array,
): RawMessage {
    return {
        id,
        seq,
        content: { t: 'encrypted', c: encodeBase64(ciphertext) },
        localId,
        createdAt: seq,
        updatedAt: seq,
    };
}

// --- Tests ---

describe('api', () => {
    let config: Config;
    let creds: Credentials;

    beforeEach(() => {
        config = makeConfig();
        creds = makeCredentials();
        vi.resetAllMocks();
    });

    afterEach(() => {
        const calls: unknown[][] = [
            ...mockedAxios.get.mock.calls.map(call => call as unknown[]),
            ...mockedAxios.delete.mock.calls.map(call => call as unknown[]),
            ...mockedAxios.post.mock.calls.map(call => [call[0], call[2]]),
        ];
        for (const call of calls) {
            const requestConfig = call[1] as {
                headers?: Record<string, string>;
                timeout?: number;
                maxContentLength?: number;
                maxBodyLength?: number;
                maxRedirects?: number;
            } | undefined;
            if (!requestConfig?.headers?.Authorization) continue;
            const isSessionCreate = call[0] === `${config.serverUrl}/v2/sessions`;
            expect(requestConfig).toMatchObject({
                timeout: 30_000,
                maxContentLength: isSessionCreate ? 256 * 1024 : 20 * 1024 * 1024,
                maxBodyLength: isSessionCreate ? 128 * 1024 : 1024 * 1024,
                maxRedirects: 0,
            });
        }
    });

    describe('resolveSessionEncryption', () => {
        it('resolves dataKey variant when dataEncryptionKey is present', () => {
            const { raw, sessionKey } = makeRawSessionWithDataKey(creds, { name: 'test' });

            const encryption = resolveSessionEncryption(raw, creds);

            expect(encryption.variant).toBe('dataKey');
            expect(encryption.key).toEqual(sessionKey);
        });

        it('resolves legacy variant when no dataEncryptionKey', () => {
            const raw = makeRawSessionLegacy(creds, { name: 'test' });

            const encryption = resolveSessionEncryption(raw, creds);

            expect(encryption.variant).toBe('legacy');
            expect(encryption.key).toEqual(creds.secret);
        });

        it('throws when dataEncryptionKey cannot be decrypted', () => {
            // Create a session with a key encrypted for a different keypair
            const otherKeyPair = tweetnacl.box.keyPair();
            const sessionKey = getRandomBytes(32);
            const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, otherKeyPair.publicKey);
            const withVersion = new Uint8Array(1 + encryptedKey.length);
            withVersion[0] = 0x00;
            withVersion.set(encryptedKey, 1);

            const raw: RawSession = {
                id: 'session-bad',
                seq: 1,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                active: true,
                activeAt: Date.now(),
                metadata: encodeBase64(getRandomBytes(50)),
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: encodeBase64(withVersion),
            };

            expect(() => resolveSessionEncryption(raw, creds)).toThrow(
                'Failed to decrypt session key for session session-bad',
            );
        });

        it('rejects an unknown wrapped-key version before decryption', () => {
            const { raw } = makeRawSessionWithDataKey(creds, { name: 'test' });
            const versioned = decodeBase64(raw.dataEncryptionKey!);
            versioned[0] = 1;
            raw.dataEncryptionKey = encodeBase64(versioned);

            expect(() => resolveSessionEncryption(raw, creds))
                .toThrow('Unsupported session key version');
        });
    });

    describe('listSessions', () => {
        it('uses bounded, non-redirecting transport for bearer requests', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: { sessions: [] } });

            await listSessions(config, creds);

            const requestConfig = mockedAxios.get.mock.calls[0][1] as Record<string, unknown>;
            expect(requestConfig).toMatchObject({
                headers: authHeader,
                maxRedirects: 0,
            });
            expect(requestConfig.timeout).toEqual(expect.any(Number));
            expect(requestConfig.maxContentLength).toEqual(expect.any(Number));
            expect(requestConfig.maxBodyLength).toEqual(expect.any(Number));
            expect(requestConfig.timeout as number).toBeGreaterThan(0);
            expect(requestConfig.maxContentLength as number).toBeGreaterThan(0);
            expect(requestConfig.maxBodyLength as number).toBeGreaterThan(0);
            expect(requestConfig.maxContentLength as number).toBeLessThanOrEqual(20 * 1024 * 1024);
            expect(requestConfig.maxBodyLength as number).toBeLessThanOrEqual(1024 * 1024);
        });

        it('returns decrypted sessions with dataKey encryption', async () => {
            const metadata = { path: '/home/user/project', host: 'my-machine' };
            const agentState = { controlledByUser: false, requests: [] };
            const { raw } = makeRawSessionWithDataKey(creds, metadata, agentState, {
                id: 'sess-1',
                active: true,
            });

            mockedAxios.get.mockResolvedValueOnce({
                data: { sessions: [raw] },
            });

            const sessions = await listSessions(config, creds);

            expect(sessions).toHaveLength(1);
            expect(sessions[0].id).toBe('sess-1');
            expect(sessions[0].metadata).toEqual(metadata);
            expect(sessions[0].agentState).toEqual(agentState);
            expect(sessions[0].encryption.variant).toBe('dataKey');
        });

        it('returns decrypted sessions with legacy encryption', async () => {
            const metadata = { path: '/old/project' };
            const raw = makeRawSessionLegacy(creds, metadata, null, {
                id: 'sess-legacy',
                active: false,
            });

            mockedAxios.get.mockResolvedValueOnce({
                data: { sessions: [raw] },
            });

            const sessions = await listSessions(config, creds);

            expect(sessions).toHaveLength(1);
            expect(sessions[0].id).toBe('sess-legacy');
            expect(sessions[0].metadata).toEqual(metadata);
            expect(sessions[0].agentState).toBeNull();
            expect(sessions[0].encryption.variant).toBe('legacy');
        });

        it('handles mixed dataKey and legacy sessions', async () => {
            const { raw: dataKeySession } = makeRawSessionWithDataKey(
                creds,
                { name: 'new' },
                null,
                { id: 'sess-new' },
            );
            const legacySession = makeRawSessionLegacy(
                creds,
                { name: 'old' },
                null,
                { id: 'sess-old' },
            );

            mockedAxios.get.mockResolvedValueOnce({
                data: { sessions: [dataKeySession, legacySession] },
            });

            const sessions = await listSessions(config, creds);

            expect(sessions).toHaveLength(2);
            expect(sessions[0].encryption.variant).toBe('dataKey');
            expect(sessions[0].metadata).toEqual({ name: 'new' });
            expect(sessions[1].encryption.variant).toBe('legacy');
            expect(sessions[1].metadata).toEqual({ name: 'old' });
        });

        it('sends authorization header', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: { sessions: [] } });

            await listSessions(config, creds);

            expect(mockedAxios.get).toHaveBeenCalledWith(
                'https://test-server.example.com/v1/sessions',
                expect.objectContaining({ headers: authHeader }),
            );
        });

        it('throws on 401 with re-authenticate message', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Unauthorized', { response: { status: 401 } });
            mockedAxios.get.mockRejectedValueOnce(err);

            await expect(listSessions(config, creds)).rejects.toThrow(
                'Authentication expired. Run `idle-agent auth login` to re-authenticate.',
            );
        });

        it('throws on 404', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Not Found', { response: { status: 404 } });
            mockedAxios.get.mockRejectedValueOnce(err);

            await expect(listSessions(config, creds)).rejects.toThrow('Not found');
        });

        it('throws on 500 server error', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Internal Server Error', { response: { status: 500 } });
            mockedAxios.get.mockRejectedValueOnce(err);

            await expect(listSessions(config, creds)).rejects.toThrow('Server error (500)');
        });

        it('does not repeat an untrusted relay error body in terminal output', async () => {
            const { AxiosError } = await import('axios');
            const marker = 'sensitive-upstream-response-marker';
            const err = new (AxiosError as any)('Bad Request', {
                response: {
                    status: 400,
                    data: { error: marker, nested: { token: marker } },
                },
            });
            mockedAxios.get.mockRejectedValueOnce(err);

            let failure: unknown;
            try {
                await listSessions(config, creds);
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain('Request failed (400)');
            expect((failure as Error).message).not.toContain(marker);
        });

        it('returns empty array for no sessions', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: { sessions: [] } });

            const sessions = await listSessions(config, creds);
            expect(sessions).toEqual([]);
        });

        it('rejects an invalid relay session-list schema before decryption', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: { sessions: 'not-an-array' } });

            await expect(listSessions(config, creds))
                .rejects.toThrow('Relay returned an invalid session list');
        });
    });

    describe('listMachines', () => {
        it('rejects an invalid relay machine-list schema before decryption', async () => {
            mockedAxios.get.mockResolvedValueOnce({
                data: [{ id: 'machine-with-missing-fields' }],
            });

            await expect(listMachines(config, creds))
                .rejects.toThrow('Relay returned an invalid machine list');
        });
    });

    describe('listActiveSessions', () => {
        it('calls the v2 active endpoint', async () => {
            mockedAxios.get.mockResolvedValueOnce({ data: { sessions: [] } });

            await listActiveSessions(config, creds);

            expect(mockedAxios.get).toHaveBeenCalledWith(
                'https://test-server.example.com/v2/sessions/active',
                expect.objectContaining({ headers: authHeader }),
            );
        });

        it('returns decrypted active sessions', async () => {
            const metadata = { path: '/active/project' };
            const { raw } = makeRawSessionWithDataKey(creds, metadata, null, {
                id: 'active-1',
                active: true,
            });

            mockedAxios.get.mockResolvedValueOnce({
                data: { sessions: [raw] },
            });

            const sessions = await listActiveSessions(config, creds);

            expect(sessions).toHaveLength(1);
            expect(sessions[0].id).toBe('active-1');
            expect(sessions[0].metadata).toEqual(metadata);
        });
    });

    describe('createSession', () => {
        it('creates a session with encrypted metadata and key', async () => {
            const metadata = { path: '/new/project', host: 'laptop' };

            // The createSession function generates a sessionKey, encrypts it, and sends it.
            // Echo the submitted session fields as the relay's stored record.
            mockedAxios.post.mockImplementation(async (_url: string, body?: unknown) => {
                const reqBody = body as {
                    id: string;
                    tag: string;
                    metadata: string;
                    dataEncryptionKey: string;
                };

                return {
                    data: {
                        session: {
                            id: reqBody.id,
                            seq: 1,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                            active: true,
                            activeAt: Date.now(),
                            metadata: reqBody.metadata,
                            metadataVersion: 0,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: reqBody.dataEncryptionKey,
                        },
                    },
                };
            });

            const result = await createSession(config, creds, {
                tag: 'my-project',
                metadata,
            });

            expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
            expect(result.metadata).toEqual(metadata);
            expect(result.sessionKey).toBeInstanceOf(Uint8Array);
            expect(result.sessionKey.length).toBe(32);
            expect(result.encryption.variant).toBe('dataKey');

            // Verify the POST was called with correct args
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://test-server.example.com/v2/sessions',
                expect.objectContaining({
                    id: result.id,
                    tag: 'my-project',
                    metadata: expect.any(String),
                    dataEncryptionKey: expect.any(String),
                }),
                expect.objectContaining({ headers: authHeader }),
            );
            expect(mockedAxios.post.mock.calls[0][2]).toMatchObject({
                timeout: 30_000,
                maxContentLength: 256 * 1024,
                maxBodyLength: 128 * 1024,
                maxRedirects: 0,
            });
        });

        it('returns existing session when tag already exists', async () => {
            const existingMetadata = { path: '/existing' };
            const { raw } = makeRawSessionWithDataKey(creds, existingMetadata, null, {
                id: 'existing-session',
            });

            mockedAxios.post.mockResolvedValueOnce({
                data: { session: raw },
            });

            const result = await createSession(config, creds, {
                tag: 'existing-tag',
                metadata: existingMetadata,
            });

            expect(result.id).toBe('existing-session');
            // Existing rows carry their own wrapped data key; the returned key
            // therefore comes from the relay row, not the discarded proposal.
            expect(result.metadata).toEqual(existingMetadata);
        });

        it('negotiates the current create contract before an older relay can mutate state', async () => {
            const { AxiosError } = await import('axios');
            mockedAxios.post.mockRejectedValueOnce(
                new (AxiosError as any)('Not Found', { response: { status: 404 } }),
            );

            await expect(createSession(config, creds, {
                tag: 'requires-current-relay',
                metadata: { path: '/workspace' },
            })).rejects.toThrow('relay does not support bound session creation');
            expect(mockedAxios.post).toHaveBeenCalledTimes(1);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://test-server.example.com/v2/sessions',
                expect.any(Object),
                expect.any(Object),
            );
        });

        it.each([
            ['oversized ID', { id: 'x'.repeat(65) }],
            ['unsafe metadata version', { metadataVersion: Number.MAX_SAFE_INTEGER + 1 }],
            ['oversized encrypted metadata', { metadata: 'x'.repeat((16 * 1024) + 1) }],
        ])('rejects an invalid %s before key unwrap or field decryption', async (_label, invalidFields) => {
            mockedAxios.post.mockImplementationOnce(async (_url: string, body?: unknown) => {
                const request = body as {
                    id: string;
                    metadata: string;
                    dataEncryptionKey: string;
                };
                return {
                    data: {
                        session: {
                            id: request.id,
                            seq: 0,
                            createdAt: 1,
                            updatedAt: 1,
                            active: true,
                            activeAt: 1,
                            metadata: request.metadata,
                            metadataVersion: 0,
                            agentState: null,
                            agentStateVersion: 0,
                            dataEncryptionKey: request.dataEncryptionKey,
                            ...invalidFields,
                        },
                    },
                };
            });

            await expect(createSession(config, creds, {
                tag: 'invalid-response',
                metadata: { path: '/workspace' },
            })).rejects.toThrow('Relay returned an invalid session response');
        });

        it('throws on server error during create', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Server Error', { response: { status: 500 } });
            mockedAxios.post.mockRejectedValueOnce(err);

            await expect(
                createSession(config, creds, { tag: 'test', metadata: {} }),
            ).rejects.toThrow('Server error (500)');
        });
    });

    describe('getSessionMessages', () => {
        it('fetches and decrypts messages with dataKey encryption', async () => {
            const { raw: rawSession, sessionKey } = makeRawSessionWithDataKey(
                creds,
                { path: '/project' },
                null,
                { id: 'msg-session' },
            );

            const encryption = resolveSessionEncryption(rawSession, creds);

            // Create encrypted messages
            const msgContent1 = { role: 'user', text: 'Hello agent' };
            const msgContent2 = { role: 'assistant', text: 'Hello! How can I help?' };
            const encMsg1 = encryptWithDataKey(msgContent1, sessionKey);
            const encMsg2 = encryptWithDataKey(msgContent2, sessionKey);

            const rawMessages: RawMessage[] = [
                {
                    id: 'msg-1',
                    seq: 1,
                    content: { t: 'encrypted', c: encodeBase64(encMsg1) },
                    localId: 'local-1',
                    createdAt: 1000,
                    updatedAt: 1000,
                },
                {
                    id: 'msg-2',
                    seq: 2,
                    content: { t: 'encrypted', c: encodeBase64(encMsg2) },
                    localId: null,
                    createdAt: 2000,
                    updatedAt: 2000,
                },
            ];

            mockedAxios.get.mockResolvedValueOnce({
                data: { messages: rawMessages },
            });

            const messages = await getSessionMessages(config, creds, 'msg-session', encryption);

            expect(messages).toHaveLength(2);
            expect(messages[0].content).toEqual(msgContent1);
            expect(messages[0].id).toBe('msg-1');
            expect(messages[1].content).toEqual(msgContent2);
            expect(messages[1].id).toBe('msg-2');
        });

        it('fetches and decrypts messages with legacy encryption', async () => {
            const rawSession = makeRawSessionLegacy(
                creds,
                { path: '/legacy-project' },
                null,
                { id: 'legacy-msg-session' },
            );

            const encryption = resolveSessionEncryption(rawSession, creds);

            const msgContent = { role: 'user', text: 'Legacy message' };
            const encMsg = encryptLegacy(msgContent, creds.secret);

            const rawMessages: RawMessage[] = [
                {
                    id: 'legacy-msg-1',
                    seq: 1,
                    content: { t: 'encrypted', c: encodeBase64(encMsg) },
                    localId: null,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            ];

            mockedAxios.get.mockResolvedValueOnce({
                data: { messages: rawMessages },
            });

            const messages = await getSessionMessages(config, creds, 'legacy-msg-session', encryption);

            expect(messages).toHaveLength(1);
            expect(messages[0].content).toEqual(msgContent);
        });

        it('joins authenticated message identity to the requested session and outer local ID', async () => {
            const sessionKey = getRandomBytes(32);
            const encryption = { key: sessionKey, variant: 'dataKey' as const };
            const valid = {
                role: 'user',
                text: 'valid',
                messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'local-a' },
            };
            const wrongSession = {
                role: 'user',
                text: 'wrong session',
                messageIdentity: { v: 1, sessionId: 'session-b', messageId: 'local-b' },
            };
            const wrongLocalId = {
                role: 'user',
                text: 'wrong local id',
                messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'inside-id' },
            };
            mockedAxios.get.mockResolvedValueOnce({
                data: {
                    messages: [
                        rawHistoryMessage('row-a', 1, 'local-a', encryptWithDataKey(valid, sessionKey)),
                        rawHistoryMessage('row-b', 2, 'local-b', encryptWithDataKey(wrongSession, sessionKey)),
                        rawHistoryMessage('row-c', 3, 'outside-id', encryptWithDataKey(wrongLocalId, sessionKey)),
                    ],
                },
            });

            const messages = await getSessionMessages(config, creds, 'session-a', encryption);

            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatchObject({ id: 'row-a', localId: 'local-a', content: valid });
        });

        it('filters authenticated identity replay and exact identity-less ciphertext replay', async () => {
            const sessionKey = getRandomBytes(32);
            const encryption = { key: sessionKey, variant: 'dataKey' as const };
            const authenticated = {
                role: 'assistant',
                text: 'current',
                messageIdentity: { v: 1, sessionId: 'session-a', messageId: 'local-a' },
            };
            const authenticatedCiphertext = encryptWithDataKey(authenticated, sessionKey);
            const legacyCiphertext = encryptWithDataKey({ role: 'assistant', text: 'legacy' }, sessionKey);
            mockedAxios.get.mockResolvedValueOnce({
                data: {
                    messages: [
                        rawHistoryMessage('current-a', 1, 'local-a', authenticatedCiphertext),
                        rawHistoryMessage('current-replay', 99, 'local-a', authenticatedCiphertext),
                        rawHistoryMessage('legacy-a', 2, null, legacyCiphertext),
                        rawHistoryMessage('legacy-replay', 100, null, legacyCiphertext),
                    ],
                },
            });

            const messages = await getSessionMessages(config, creds, 'session-a', encryption);

            expect(messages.map(message => message.id)).toEqual(['current-a', 'legacy-a']);
        });

        it('throws on 404 for messages endpoint', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Not Found', { response: { status: 404 } });
            mockedAxios.get.mockRejectedValueOnce(err);

            const encryption = { key: creds.secret, variant: 'legacy' as const };
            await expect(
                getSessionMessages(config, creds, 'bad-id', encryption),
            ).rejects.toThrow('Not found');
        });

        it('rejects an invalid relay message-list schema before decryption', async () => {
            mockedAxios.get.mockResolvedValueOnce({
                data: { messages: [{ id: 'message-with-missing-fields' }] },
            });

            await expect(getSessionMessages(
                config,
                creds,
                'session-1',
                { key: getRandomBytes(32), variant: 'dataKey' },
            )).rejects.toThrow('Relay returned an invalid message list');
        });
    });

    describe('deleteSession', () => {
        it('sends DELETE request with correct URL and auth headers', async () => {
            mockedAxios.delete.mockResolvedValueOnce({ data: {} });

            await deleteSession(config, creds, 'session-to-delete');

            expect(mockedAxios.delete).toHaveBeenCalledWith(
                'https://test-server.example.com/v1/sessions/session-to-delete',
                expect.objectContaining({ headers: authHeader }),
            );
        });

        it('throws on 404', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Not Found', { response: { status: 404 } });
            mockedAxios.delete.mockRejectedValueOnce(err);

            await expect(deleteSession(config, creds, 'bad-id')).rejects.toThrow('Not found');
        });

        it('throws on 401 with re-authenticate message', async () => {
            const { AxiosError } = await import('axios');
            const err = new (AxiosError as any)('Unauthorized', { response: { status: 401 } });
            mockedAxios.delete.mockRejectedValueOnce(err);

            await expect(deleteSession(config, creds, 'some-id')).rejects.toThrow(
                'Authentication expired',
            );
        });
    });
});
