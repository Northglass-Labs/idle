import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, decryptBlob, encodeBase64, encrypt } from './encryption';
import type { Update } from './types';
import { logger } from '@/ui/logger';
import { encryptSessionField } from './sessionFieldEncryption';
import { MAX_MESSAGE_INGRESS_BODY_BYTES } from '@northglass/idle-wire';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableIncomingMessageReplayStore } from './messages/DurableIncomingMessageReplayStore';

const {
    mockIo,
    mockAxiosGet,
    mockAxiosPost,
    mockAxiosPut,
    mockBackoff,
    mockDelay,
    mockShouldReconnect,
    testConfiguration,
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockAxiosGet: vi.fn(),
    mockAxiosPost: vi.fn(),
    mockAxiosPut: vi.fn(),
    mockBackoff: vi.fn(async <T>(callback: () => Promise<T>) => {
        let lastError: unknown;
        for (let i = 0; i < 20; i += 1) {
            try {
                return await callback();
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }),
    mockDelay: vi.fn(async () => undefined),
    mockShouldReconnect: vi.fn(() => true),
    testConfiguration: { idleHomeDir: '' },
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('axios', () => ({
    default: {
        get: mockAxiosGet,
        post: mockAxiosPost,
        put: mockAxiosPut
    }
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://server.test',
        get idleHomeDir() {
            return testConfiguration.idleHomeDir;
        },
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/utils/time', () => ({
    backoff: mockBackoff,
    delay: mockDelay
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/tmp',
            host: 'localhost',
            homeDir: '/home/user',
            idleHomeDir: '/home/user/.idle',
            idleLibDir: '/home/user/.idle/lib',
            idleToolsDir: '/home/user/.idle/tools'
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const
    };
}

function encryptContent(
    session: { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' },
    content: unknown,
): string {
    return encodeBase64(encrypt(session.encryptionKey, session.encryptionVariant, content));
}

function createEquivalentNonCanonicalBase64(value: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const paddingCharacters = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    if (paddingCharacters === 0) {
        throw new Error('Expected padded base64 input');
    }
    const characterIndex = value.length - paddingCharacters - 1;
    const sextet = alphabet.indexOf(value[characterIndex]);
    const unusedBitMask = paddingCharacters === 2 ? 0b1111 : 0b11;
    const replacement = (sextet & ~unusedBitMask) | 1;
    return `${value.slice(0, characterIndex)}${alphabet[replacement]}${value.slice(characterIndex + 1)}`;
}

function createNewMessageUpdate(
    seq: number,
    encryptedContent: string,
    localId: string | null = null,
): Update {
    return {
        id: `upd-${seq}`,
        seq,
        createdAt: Date.now(),
        body: {
            t: 'new-message',
            sid: 'test-session-id',
            message: {
                id: `msg-${seq}`,
                seq,
                localId,
                content: {
                    t: 'encrypted',
                    c: encryptedContent
                },
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
    };
}

function createFetchedMessage(
    session: ReturnType<typeof makeSession>,
    seq: number,
    content: unknown = {
        role: 'user',
        content: { type: 'text', text: `m${seq}` }
    }
) {
    return {
        id: `msg-${seq}`,
        seq,
        content: {
            t: 'encrypted' as const,
            c: encryptContent(session, content)
        },
        localId: null,
        createdAt: seq,
        updatedAt: seq
    };
}

async function waitForCheck(check: () => void, timeoutMs = 2000) {
    const startedAt = Date.now();
    let lastError: unknown;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            check();
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw lastError;
}

describe('ApiSessionClient v3 messages API migration', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;
    let session: ReturnType<typeof makeSession>;
    let idleHomeDir: string;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        session = makeSession();
        idleHomeDir = mkdtempSync(join(tmpdir(), 'idle-api-session-test-'));
        testConfiguration.idleHomeDir = idleHomeDir;
        mockSocket = {
            connected: true,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            off: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(async () => ({ result: 'error' })),
            volatile: {
                emit: vi.fn()
            },
            close: vi.fn()
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        rmSync(idleHomeDir, { recursive: true, force: true });
    });

    it('registers core socket handlers and connects', () => {
        new ApiSessionClient('ordinary-api-token', session, 'rpc-registration-token');

        expect(mockIo).toHaveBeenCalledWith('https://server.test', expect.objectContaining({
            auth: expect.objectContaining({ token: 'rpc-registration-token' }),
        }));
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('update', expect.any(Function));
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it('rejects captured state ciphertext relabeled to a newer version after restart', async () => {
        (session as any).agentState = { controlledByUser: true, requests: {} };
        session.agentStateVersion = 0;
        const captured = encryptSessionField(
            { key: session.encryptionKey, variant: session.encryptionVariant },
            session.id,
            'agentState',
            1,
            {
                controlledByUser: false,
                requests: {
                    captured: { tool: 'Bash', arguments: { command: 'pwd' } },
                },
            },
        );
        mockAxiosGet.mockResolvedValueOnce({ data: { messages: [], hasMore: false } });
        const client = new ApiSessionClient('fake-token', session);

        emitSocketEvent('update', {
            id: 'rewrapped-after-restart',
            seq: 999,
            createdAt: Date.now(),
            body: {
                t: 'update-session',
                id: session.id,
                agentState: { version: 999, value: captured },
            },
        });

        expect((client as any).agentState).toEqual({
            controlledByUser: true,
            requests: {},
        });
        expect((client as any).agentStateVersion).toBe(0);
        await waitForCheck(() => expect(mockAxiosGet).toHaveBeenCalled());
        client.close();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();
        mockSocket.connected = false;

        const client = new ApiSessionClient('fake-token', session);

        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(3);

        await client.close();
    });

    it('never forwards opaque socket error text to persistent logger calls', () => {
        const opaqueErrorDetail = 'OPAQUE_SOCKET_ERROR_DETAIL_31f2';
        new ApiSessionClient('fake-token', session);

        emitSocketEvent('error', new Error(opaqueErrorDetail));

        const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
        expect(debugOutput).not.toContain(opaqueErrorDetail);
        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
            '[API] Socket error',
            expect.objectContaining({ errorType: 'error' }),
        );
    });

    it('never forwards provider tool arguments from agent state to persistent logger calls', async () => {
        const opaqueToolArgument = 'OPAQUE_AGENT_STATE_ARGUMENT_4c8b';
        const opaqueDenialReason = 'OPAQUE_AGENT_STATE_REASON_d7e1';
        const initialState = {
            requests: {
                'provider-request-id': {
                    tool: 'shell',
                    arguments: { command: opaqueToolArgument },
                    createdAt: 1,
                },
            },
        };
        const updatedState = {
            requests: {},
            completedRequests: {
                'provider-request-id': {
                    tool: 'shell',
                    arguments: { command: opaqueToolArgument },
                    createdAt: 1,
                    completedAt: 2,
                    status: 'denied' as const,
                    reason: opaqueDenialReason,
                },
            },
        };
        (session as any).agentState = initialState;
        mockSocket.emitWithAck.mockImplementationOnce(async (_event: string, data: any) => ({
            result: 'success',
            version: 1,
            agentState: data.agentState,
        }));
        const client = new ApiSessionClient('fake-token', session);

        client.updateAgentState(() => updatedState);

        await waitForCheck(() => {
            expect((client as any).agentStateVersion).toBe(1);
        });
        const debugOutput = JSON.stringify([
            ...vi.mocked(logger.debug).mock.calls,
            ...vi.mocked(logger.debugLargeJson).mock.calls,
        ]);
        expect(debugOutput).not.toContain(opaqueToolArgument);
        expect(debugOutput).not.toContain(opaqueDenialReason);
        expect(debugOutput).not.toContain('provider-request-id');
        expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
            'Agent state updated',
            expect.objectContaining({ pendingRequestCount: 0, completedRequestCount: 1 }),
        );
    });

    it('queues codex message to v3 outbox, sends once, and drains outbox', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        localId: 'local-1',
                        createdAt: 1,
                        updatedAt: 1
                    }
                ]
            }
        });

        client.sendCodexMessage({ type: 'delta', text: 'hello' });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);
        expect(typeof payload.messages[0].localId).toBe('string');
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(1);

        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                type: 'codex',
                data: { type: 'delta', text: 'hello' }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('accumulates multiple pending outbox messages into one follow-up batch', async () => {
        const client = new ApiSessionClient('fake-token', session);

        type PostResponse = {
            data: {
                messages: Array<{ id: string; seq: number; localId: string; createdAt: number; updatedAt: number }>;
            };
        };
        let resolveFirstPost!: (value: PostResponse) => void;
        mockAxiosPost
            .mockImplementationOnce(() => new Promise<PostResponse>((resolve) => {
                resolveFirstPost = resolve;
            }))
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        { id: 'msg-2', seq: 2, localId: 'local-2', createdAt: 2, updatedAt: 2 },
                        { id: 'msg-3', seq: 3, localId: 'local-3', createdAt: 3, updatedAt: 3 }
                    ]
                }
            });

        client.sendCodexMessage({ type: 'first' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        client.sendCodexMessage({ type: 'second' });
        client.sendCodexMessage({ type: 'third' });

        resolveFirstPost({
            data: {
                messages: [
                    { id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }
                ]
            }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });

        const secondPayload = mockAxiosPost.mock.calls[1][1];
        expect(secondPayload.messages).toHaveLength(2);
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(3);
    });

    it('splits oversized outbox groups into bounded requests while preserving newest-first delivery', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const content = 'x'.repeat(Math.floor(MAX_MESSAGE_INGRESS_BODY_BYTES * 0.55));
        (client as any).pendingOutbox = [
            { localId: 'older', content },
            { localId: 'newer', content },
        ];
        mockAxiosPost.mockResolvedValue({ data: { messages: [] } });

        await (client as any).flushOutbox();

        expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        expect(mockAxiosPost.mock.calls[0][1].messages.map((message: any) => message.localId))
            .toEqual(['newer']);
        expect(mockAxiosPost.mock.calls[1][1].messages.map((message: any) => message.localId))
            .toEqual(['older']);
        for (const call of mockAxiosPost.mock.calls) {
            expect(new TextEncoder().encode(JSON.stringify(call[1])).byteLength)
                .toBeLessThanOrEqual(MAX_MESSAGE_INGRESS_BODY_BYTES);
            expect(call[2].maxRedirects).toBe(0);
        }
        expect((client as any).pendingOutbox).toHaveLength(0);
    });

    it('retries failed POST and succeeds without dropping queued messages', async () => {
        const client = new ApiSessionClient('fake-token', session);

        mockAxiosPost
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        { id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }
                    ]
                }
            });

        client.sendCodexMessage({ type: 'retry-me' });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });

        const firstPayload = mockAxiosPost.mock.calls[0][1];
        const secondPayload = mockAxiosPost.mock.calls[1][1];
        expect(secondPayload).toEqual(firstPayload);
        expect((client as any).pendingOutbox).toHaveLength(0);
        expect((client as any).lastSeq).toBe(1);
    });

    it('sends claude user text as modern session envelope', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendClaudeSessionMessage({
            type: 'user',
            message: { content: 'hi there' },
            isSidechain: false,
            isMeta: false
        } as any);

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionUser = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(sessionUser).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                ev: {
                    t: 'text',
                    text: 'hi there'
                }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
        expect(typeof (sessionUser as any).content.time).toBe('number');
    });

    it('emits usage cost only when the assistant model has reviewed pricing', () => {
        const client = new ApiSessionClient('fake-token', session);
        const usage = {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
        };

        client.sendUsageData(usage, 'claude-opus-4-8');
        client.sendUsageData(usage, 'unreviewed-opus-model');
        client.sendUsageData(usage);
        client.sendUsageData({
            ...usage,
            cache_creation: {
                ephemeral_1h_input_tokens: 1_000_000,
                ephemeral_5m_input_tokens: 1_000_000,
            },
        }, 'claude-opus-4-8');

        const usageReports = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'usage-report');
        expect(usageReports).toHaveLength(1);
        expect(usageReports[0][1]).toMatchObject({
            tokens: {
                total: 4_000_000,
                input: 1_000_000,
                output: 1_000_000,
                cache_creation: 1_000_000,
                cache_read: 1_000_000,
            },
            cost: { total: 36.75, input: 11.75, output: 25 },
        });
    });

    it('publishes the bounded model ID observed in an assistant message', async () => {
        (session.metadata as any).currentModelCode = 'claude-sonnet-4-5';
        mockSocket.emitWithAck.mockImplementation(async (event: string, data: any) => {
            if (event === 'update-metadata') {
                return { result: 'success', version: 1, metadata: data.metadata };
            }
            return { result: 'error' };
        });
        const client = new ApiSessionClient('fake-token', session);

        (client as any).applyClaudeSessionMessageSideEffects({
            type: 'assistant',
            uuid: 'assistant-model-update',
            message: { model: '  CLAUDE-OPUS-4-8-20260713  ' },
        });

        await waitForCheck(() => {
            expect(client.getMetadata()?.currentModelCode).toBe('claude-opus-4-8-20260713');
        });
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('does not publish an unbounded or malformed assistant model ID', async () => {
        const client = new ApiSessionClient('fake-token', session);

        (client as any).applyClaudeSessionMessageSideEffects({
            type: 'assistant',
            uuid: 'assistant-invalid-model',
            message: { model: `claude-opus-${'x'.repeat(256)}` },
        });

        await Promise.resolve();
        expect(client.getMetadata()?.currentModelCode).toBeUndefined();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('uploads local Claude transcript image blocks and sends file before user text', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x01, 0x02, 0x03]);

        mockAxiosPost.mockImplementation(async (url: string, payload: any) => {
            if (url.endsWith('/attachments/request-upload')) {
                expect(payload).toMatchObject({
                    filename: 'claude-image-1.png',
                });
                expect(payload.size).toBeGreaterThan(pngBytes.length);
                return {
                    data: {
                        ref: 'sessions/test-session-id/attachments/image.enc',
                        uploadUrl: 'https://server.test/v1/sessions/test-session-id/attachments/image.enc',
                        method: 'PUT',
                    },
                };
            }

            return {
                data: {
                    messages: payload.messages.map((_message: unknown, index: number) => ({
                        id: `msg-${index + 1}`,
                        seq: index + 1,
                        localId: `local-${index + 1}`,
                        createdAt: 1,
                        updatedAt: 1,
                    })),
                },
            };
        });
        mockAxiosPut.mockResolvedValueOnce({ data: { ok: true } });

        await client.sendClaudeSessionMessageFromLocalTranscript({
            type: 'user',
            uuid: 'u-image-1',
            isSidechain: false,
            isMeta: false,
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: 'please inspect this' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: Buffer.from(pngBytes).toString('base64'),
                        },
                    },
                ],
            },
        } as any);

        await waitForCheck(() => {
            expect(mockAxiosPut).toHaveBeenCalledTimes(1);
            expect(mockAxiosPost.mock.calls.some(([url]) => url === 'https://server.test/v3/sessions/test-session-id/messages')).toBe(true);
        });

        const uploadBody = mockAxiosPut.mock.calls[0][1];
        const blobKey = await client.getBlobKey();
        expect(decryptBlob(new Uint8Array(uploadBody), blobKey)).toEqual(pngBytes);

        const messagesPost = mockAxiosPost.mock.calls.find(([url]) => {
            return url === 'https://server.test/v3/sessions/test-session-id/messages';
        });
        expect(messagesPost).toBeDefined();
        const sentMessages = messagesPost![1].messages;
        expect(sentMessages).toHaveLength(2);

        const decrypted = sentMessages.map((message: { content: string }) => {
            return decrypt(
                session.encryptionKey,
                session.encryptionVariant,
                decodeBase64(message.content),
            );
        });

        expect(decrypted[0]).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                claudeUuid: 'u-image-1',
                ev: {
                    t: 'file',
                    ref: 'sessions/test-session-id/attachments/image.enc',
                    name: 'claude-image-1.png',
                    size: pngBytes.length,
                    mimeType: 'image/png',
                },
            },
            meta: {
                sentFrom: 'cli',
            },
        });
        expect(decrypted[1]).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                claudeUuid: 'u-image-1',
                ev: {
                    t: 'text',
                    text: 'please inspect this',
                },
            },
            meta: {
                sentFrom: 'cli',
            },
        });
    });

    it('uploads local Codex image files with codex item ids', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

        mockAxiosPost.mockImplementation(async (url: string, payload: any) => {
            if (url.endsWith('/attachments/request-upload')) {
                expect(payload).toMatchObject({
                    filename: 'codex-image-1.png',
                });
                return {
                    data: {
                        ref: 'sessions/test-session-id/attachments/codex-image.enc',
                        uploadUrl: 'https://server.test/v1/sessions/test-session-id/attachments/codex-image.enc',
                        method: 'PUT',
                    },
                };
            }

            return {
                data: {
                    messages: payload.messages.map((_message: unknown, index: number) => ({
                        id: `msg-${index + 1}`,
                        seq: index + 1,
                        localId: `local-${index + 1}`,
                        createdAt: 1,
                        updatedAt: 1,
                    })),
                },
            };
        });
        mockAxiosPut.mockResolvedValueOnce({ data: { ok: true } });

        const envelope = await client.uploadLocalImageAttachmentEnvelope({
            data: pngBytes,
            mimeType: 'image/png',
            name: 'codex-image-1.png',
        }, {
            codexItemId: 'codex-user-item-1',
        });

        expect(envelope).toMatchObject({
            role: 'user',
            codexItemId: 'codex-user-item-1',
            ev: {
                t: 'file',
                ref: 'sessions/test-session-id/attachments/codex-image.enc',
                name: 'codex-image-1.png',
                size: pngBytes.length,
                mimeType: 'image/png',
            },
        });

        const uploadBody = mockAxiosPut.mock.calls[0][1];
        const blobKey = await client.getBlobKey();
        expect(decryptBlob(new Uint8Array(uploadBody), blobKey)).toEqual(pngBytes);
    });

    it('sends session protocol messages through enqueueMessage with session envelope', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        const envelope = {
            id: 'env-1',
            time: 1000,
            role: 'agent' as const,
            turn: 'turn-1',
            ev: { t: 'text' as const, text: 'hello from session protocol' }
        };
        client.sendSessionProtocolMessage(envelope);

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('sends only modern payload for user session envelopes', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-user-1',
            time: 1001,
            role: 'user',
            ev: { t: 'text', text: 'shadow this' }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionUser = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );
        expect(sessionUser).toMatchObject({
            role: 'session',
            content: {
                id: 'env-user-1',
                time: 1001,
                role: 'user',
                ev: { t: 'text', text: 'shadow this' }
            }
        });
    });

    it('sends modern session envelope for user text', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionProtocolMessage({
            id: 'env-user-flag-on-1',
            time: 1002,
            role: 'user',
            ev: { t: 'text', text: 'session only' }
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        expect(payload.messages).toHaveLength(1);

        const sessionOnly = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(sessionOnly).toMatchObject({
            role: 'session',
            content: {
                role: 'user',
                ev: { t: 'text', text: 'session only' }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
        expect(typeof (sessionOnly as any).content.time).toBe('number');
    });

    it('sends ACP agent messages through enqueueMessage', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendAgentMessage('codex', {
            type: 'message',
            message: 'hi'
        });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
                data: {
                    type: 'message',
                    message: 'hi'
                }
            },
            meta: {
                sentFrom: 'cli'
            }
        });
    });

    it('sends session events through enqueueMessage', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.sendSessionEvent({ type: 'ready' }, 'event-1');

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content)
        );

        expect(decrypted).toEqual({
            role: 'agent',
            content: {
                id: 'event-1',
                type: 'event',
                data: {
                    type: 'ready'
                }
            }
        });
    });

    it('fetchMessages requests the newest history page initially and routes user messages to callback', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const userMessage = {
            role: 'user',
            content: {
                type: 'text',
                text: 'from fetch'
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: {
                            t: 'encrypted',
                            c: encryptContent(session, userMessage)
                        },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet.mock.calls[0][0]).toBe('https://server.test/v3/sessions/test-session-id/messages');
        expect(mockAxiosGet.mock.calls[0][1].params).toEqual({
            before_seq: Number.MAX_SAFE_INTEGER,
            limit: 100
        });
        expect(mockAxiosGet.mock.calls[0][1].maxContentLength).toBe(20 * 1024 * 1024);
        expect(mockAxiosGet.mock.calls[0][1].maxRedirects).toBe(0);
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect((client as any).lastSeq).toBe(1);
    });

    it('fetchMessages uses incremental cursor and paginates while hasMore is true', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        (client as any).lastSeq = 2;

        const message3 = {
            role: 'user',
            content: { type: 'text', text: 'm3' }
        };
        const message4 = {
            role: 'user',
            content: { type: 'text', text: 'm4' }
        };

        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        {
                            id: 'msg-3',
                            seq: 3,
                            content: { t: 'encrypted', c: encryptContent(session, message3) },
                            localId: null,
                            createdAt: 3000,
                            updatedAt: 3000
                        }
                    ],
                    hasMore: true
                }
            })
            .mockResolvedValueOnce({
                data: {
                    messages: [
                        {
                            id: 'msg-4',
                            seq: 4,
                            content: { t: 'encrypted', c: encryptContent(session, message4) },
                            localId: null,
                            createdAt: 4000,
                            updatedAt: 4000
                        }
                    ],
                    hasMore: false
                }
            });

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(2);
        expect(mockAxiosGet.mock.calls[1][1].params.after_seq).toBe(3);
        expect(onUserMessage).toHaveBeenCalledTimes(2);
        expect((client as any).lastSeq).toBe(4);
    });

    it('fetchMessages drops stale replayed rows before routing fresh forward messages', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 2;

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    createFetchedMessage(session, 2),
                    createFetchedMessage(session, 3)
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'm3' }
        });
        expect((client as any).lastSeq).toBe(3);
    });

    it('routes an authenticated fetched prompt only once when the relay rewraps its ciphertext', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const authenticatedPrompt = {
            role: 'user',
            content: { type: 'text', text: 'run this once' },
            messageIdentity: {
                v: 1,
                sessionId: session.id,
                messageId: 'mobile-message-1',
            },
        };
        const capturedCiphertext = encryptContent(session, authenticatedPrompt);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'relay-row-2',
                        seq: 2,
                        localId: 'relay-rewrapped-id',
                        content: { t: 'encrypted', c: capturedCiphertext },
                        createdAt: 2,
                        updatedAt: 2,
                    },
                    {
                        id: 'relay-row-1',
                        seq: 1,
                        localId: 'mobile-message-1',
                        content: { t: 'encrypted', c: capturedCiphertext },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                hasMore: false,
            },
        });

        await (client as any).fetchMessages();

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(authenticatedPrompt);
        expect((client as any).lastSeq).toBe(2);
    });

    it.each(['legacy', 'dataKey'] as const)(
        'routes an exact identity-less ciphertext only once under %s encryption while accepting separately encrypted equal text',
        async (encryptionVariant) => {
            const variantSession = { ...session, encryptionVariant };
            const client = new ApiSessionClient('fake-token', variantSession);
            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            let legacyPrompt;
            let capturedCiphertext = '';
            for (let suffixLength = 0; suffixLength < 3; suffixLength += 1) {
                legacyPrompt = {
                    role: 'user',
                    content: { type: 'text', text: `legacy prompt${'x'.repeat(suffixLength)}` },
                };
                capturedCiphertext = encryptContent(variantSession, legacyPrompt);
                if (capturedCiphertext.endsWith('=')) break;
            }
            expect(capturedCiphertext.endsWith('=')).toBe(true);
            const equivalentCiphertext = createEquivalentNonCanonicalBase64(capturedCiphertext);
            expect(equivalentCiphertext).not.toBe(capturedCiphertext);
            expect(Buffer.from(equivalentCiphertext, 'base64')).toEqual(Buffer.from(capturedCiphertext, 'base64'));
            const independentlyEncryptedCiphertext = encryptContent(variantSession, legacyPrompt);
            expect(independentlyEncryptedCiphertext).not.toBe(capturedCiphertext);
            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    messages: [
                        {
                            id: 'independent-row-4',
                            seq: 4,
                            localId: 'independent-id',
                            content: { t: 'encrypted', c: independentlyEncryptedCiphertext },
                            createdAt: 4,
                            updatedAt: 4,
                        },
                        {
                            id: 'exact-replay-row-3',
                            seq: 3,
                            localId: 'relay-rewrapped-id-2',
                            content: { t: 'encrypted', c: capturedCiphertext },
                            createdAt: 3,
                            updatedAt: 3,
                        },
                        {
                            id: 'relay-row-2',
                            seq: 2,
                            localId: 'relay-rewrapped-id',
                            content: { t: 'encrypted', c: equivalentCiphertext },
                            createdAt: 2,
                            updatedAt: 2,
                        },
                        {
                            id: 'relay-row-1',
                            seq: 1,
                            localId: 'legacy-original-id',
                            content: { t: 'encrypted', c: capturedCiphertext },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                    hasMore: false,
                },
            });

            await (client as any).fetchMessages();

            expect(onUserMessage).toHaveBeenCalledTimes(2);
            expect((client as any).lastSeq).toBe(4);
        },
    );

    it('fetchMessages caps initial history at the newest 500 messages and restores chronological order', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        for (let high = 600; high >= 200; high -= 100) {
            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    messages: Array.from(
                        { length: 100 },
                        (_, index) => createFetchedMessage(session, high - index)
                    ),
                    hasMore: true
                }
            });
        }

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(5);
        expect(mockAxiosGet.mock.calls.map((call) => call[1].params.before_seq)).toEqual([
            Number.MAX_SAFE_INTEGER,
            501,
            401,
            301,
            201
        ]);
        expect(onUserMessage).toHaveBeenCalledTimes(500);
        expect(onUserMessage.mock.calls[0][0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'm101' }
        });
        expect(onUserMessage.mock.calls[499][0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'm600' }
        });
        expect((client as any).lastSeq).toBe(600);
    }, 15_000);

    it('fetchMessages abandons an oversized forward backlog and keeps only the newest 500 messages', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 100;

        for (let low = 101; low <= 501; low += 100) {
            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    messages: Array.from(
                        { length: 100 },
                        (_, index) => createFetchedMessage(session, low + index)
                    ),
                    hasMore: true
                }
            });
        }
        for (let high = 700; high >= 300; high -= 100) {
            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    messages: Array.from(
                        { length: 100 },
                        (_, index) => createFetchedMessage(session, high - index)
                    ),
                    hasMore: true
                }
            });
        }
        mockAxiosGet.mockRejectedValueOnce(new Error('message sync exceeded the request budget'));

        await (client as any).fetchMessages();

        expect(mockAxiosGet).toHaveBeenCalledTimes(10);
        expect(mockAxiosGet.mock.calls.slice(0, 5).map((call) => call[1].params.after_seq)).toEqual([
            100,
            200,
            300,
            400,
            500
        ]);
        expect(mockAxiosGet.mock.calls.slice(5).map((call) => call[1].params.before_seq)).toEqual([
            Number.MAX_SAFE_INTEGER,
            601,
            501,
            401,
            301
        ]);
        expect(onUserMessage).toHaveBeenCalledTimes(500);
        expect(onUserMessage.mock.calls[0][0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'm201' }
        });
        expect(onUserMessage.mock.calls[499][0]).toEqual({
            role: 'user',
            content: { type: 'text', text: 'm700' }
        });
        expect((client as any).lastSeq).toBe(700);
    }, 15_000);

    it('fetchMessages rejects a relay page that exceeds the requested message count', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: Array.from(
                    { length: 101 },
                    (_, index) => createFetchedMessage(session, 101 - index)
                ),
                hasMore: false
            }
        });

        await expect((client as any).fetchMessages()).resolves.toBeUndefined();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(onUserMessage).not.toHaveBeenCalled();
        expect((client as any).lastSeq).toBe(0);
    });

    it('fetchMessages stops the current sync when Axios rejects an oversized response', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const oversizedResponseError = Object.assign(
            new Error('maxContentLength size exceeded'),
            { code: 'ERR_BAD_RESPONSE' }
        );
        mockAxiosGet.mockRejectedValueOnce(oversizedResponseError);

        await expect((client as any).fetchMessages()).resolves.toBeUndefined();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect((client as any).lastSeq).toBe(0);
    });

    it('fetchMessages stops pagination when hasMore is true but seq cursor does not advance', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 2;

        mockAxiosGet
            .mockResolvedValueOnce({
                data: {
                    messages: [],
                    hasMore: true
                }
            })
            .mockRejectedValueOnce(new Error('should not request another page when cursor is stalled'));

        await expect((client as any).fetchMessages()).resolves.toBeUndefined();

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(2);
        expect((client as any).lastSeq).toBe(2);
    });

    it('routes non-user fetched messages through EventEmitter message event', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        const onMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        client.on('message', onMessage);

        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'user text' }
        };
        const agentMessage = {
            role: 'agent',
            content: {
                type: 'output',
                data: { answer: 'agent response' }
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: { t: 'encrypted', c: encryptContent(session, userMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    },
                    {
                        id: 'msg-2',
                        seq: 2,
                        content: { t: 'encrypted', c: encryptContent(session, agentMessage) },
                        localId: null,
                        createdAt: 2000,
                        updatedAt: 2000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(agentMessage);
    });

    it('routes file events without logging sensitive names or refs', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onFileEvent = vi.fn();
        const sensitiveName = 'https://upload.example.test/image.png?token=secret';
        const sensitiveRef = 'sessions/test-session-id/attachments/secret-ref.enc?signature=secret';
        client.onFileEvent(onFileEvent);

        const fileMessage = {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'file-event-1',
                    time: 1000,
                    role: 'user',
                    ev: {
                        t: 'file',
                        ref: sensitiveRef,
                        name: sensitiveName,
                        size: 42,
                        mimeType: 'image/png',
                    }
                }
            }
        };

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [
                    {
                        id: 'msg-1',
                        seq: 1,
                        content: { t: 'encrypted', c: encryptContent(session, fileMessage) },
                        localId: null,
                        createdAt: 1000,
                        updatedAt: 1000
                    }
                ],
                hasMore: false
            }
        });

        await (client as any).fetchMessages();

        expect(onFileEvent).toHaveBeenCalledWith(fileMessage);
        const debugOutput = JSON.stringify(vi.mocked(logger.debug).mock.calls);
        expect(debugOutput).not.toContain(sensitiveName);
        expect(debugOutput).not.toContain(sensitiveRef);
        expect(debugOutput).not.toContain('signature=secret');
    });

    it('applies file event socket updates directly without logging sensitive names or refs', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onFileEvent = vi.fn();
        const sensitiveName = 'https://upload.example.test/image.png?token=socket-secret';
        const sensitiveRef = 'sessions/test-session-id/attachments/socket-secret-ref.enc?signature=socket-secret';
        client.onFileEvent(onFileEvent);

        (client as any).lastSeq = 1;
        const fileMessage = {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'file-event-2',
                    time: 1000,
                    role: 'user',
                    ev: {
                        t: 'file',
                        ref: sensitiveRef,
                        name: sensitiveName,
                        size: 64,
                        mimeType: 'image/png',
                    }
                }
            }
        };

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, fileMessage)));

        expect(onFileEvent).toHaveBeenCalledWith(fileMessage);
        expect((client as any).lastSeq).toBe(2);
        const debugOutput = JSON.stringify([
            ...vi.mocked(logger.debug).mock.calls,
            ...vi.mocked(logger.debugLargeJson).mock.calls,
        ]);
        expect(debugOutput).not.toContain(sensitiveName);
        expect(debugOutput).not.toContain(sensitiveRef);
        expect(debugOutput).not.toContain('socket-secret');
    });

    it('applies consecutive new-message updates directly (fast path)', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        (client as any).lastSeq = 1;
        const userMessage = {
            role: 'user',
            content: { type: 'text', text: 'fast-path' }
        };

        emitSocketEvent('update', createNewMessageUpdate(2, encryptContent(session, userMessage)));

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(userMessage);
        expect((client as any).lastSeq).toBe(2);
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('routes an authenticated socket prompt only once when the relay reuses its ciphertext', () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 1;

        const authenticatedPrompt = {
            role: 'user',
            content: { type: 'text', text: 'socket prompt once' },
            messageIdentity: {
                v: 1,
                sessionId: session.id,
                messageId: 'mobile-message-1',
            },
        };
        const capturedCiphertext = encryptContent(session, authenticatedPrompt);

        emitSocketEvent('update', createNewMessageUpdate(2, capturedCiphertext, 'mobile-message-1'));
        emitSocketEvent('update', createNewMessageUpdate(3, capturedCiphertext, 'relay-rewrapped-id'));

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(authenticatedPrompt);
        expect((client as any).lastSeq).toBe(3);
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('authenticates outgoing turn correlation inside the encrypted response', async () => {
        const client = new ApiSessionClient('fake-token', session);
        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-1', seq: 1, localId: 'local-1', createdAt: 1, updatedAt: 1 }]
            }
        });

        client.setActiveRequestId('sender-owned-request-id');
        client.sendCodexMessage({ type: 'delta', text: 'correlated output' });

        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        const payload = mockAxiosPost.mock.calls[0][1];
        const decrypted = decrypt(
            session.encryptionKey,
            session.encryptionVariant,
            decodeBase64(payload.messages[0].content),
        );
        expect(decrypted).toMatchObject({
            role: 'agent',
            requestId: 'sender-owned-request-id',
        });
    });

    it.each([
        {
            name: 'from another session',
            identity: { v: 1, sessionId: 'another-session', messageId: 'mobile-message-1' },
            outerLocalId: 'mobile-message-1',
        },
        {
            name: 'rewrapped under a different outer message id',
            identity: { v: 1, sessionId: 'test-session-id', messageId: 'mobile-message-1' },
            outerLocalId: 'relay-rewrapped-id',
        },
        {
            name: 'with a malformed identity',
            identity: { v: 2, sessionId: 'test-session-id', messageId: 'mobile-message-1' },
            outerLocalId: 'mobile-message-1',
        },
    ])('rejects an authenticated socket prompt $name', ({ identity, outerLocalId }) => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        (client as any).lastSeq = 1;

        const invalidPrompt = {
            role: 'user',
            content: { type: 'text', text: 'invalid authenticated replay' },
            messageIdentity: identity,
        };

        emitSocketEvent('update', createNewMessageUpdate(
            2,
            encryptContent(session, invalidPrompt),
            outerLocalId,
        ));

        expect(onUserMessage).not.toHaveBeenCalled();
        expect((client as any).lastSeq).toBe(2);
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it('seeds replay state while intentionally skipping reconnect history', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        client.skipExistingMessages();

        const authenticatedPrompt = {
            role: 'user',
            content: { type: 'text', text: 'skipped reconnect prompt' },
            messageIdentity: {
                v: 1,
                sessionId: session.id,
                messageId: 'mobile-message-1',
            },
        };
        const capturedCiphertext = encryptContent(session, authenticatedPrompt);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [{
                    id: 'relay-row-1',
                    seq: 1,
                    localId: 'mobile-message-1',
                    content: { t: 'encrypted', c: capturedCiphertext },
                    createdAt: 1,
                    updatedAt: 1,
                }],
                hasMore: false,
            },
        });

        await (client as any).fetchMessages();
        emitSocketEvent('update', createNewMessageUpdate(2, capturedCiphertext, 'mobile-message-1'));

        expect(onUserMessage).not.toHaveBeenCalled();
        expect((client as any).lastSeq).toBe(2);
    });

    it('rejects an authenticated replay after the session client is reconstructed', () => {
        const first = new ApiSessionClient('fake-token', session);
        const firstCallback = vi.fn();
        first.onUserMessage(firstCallback);
        const prompt = {
            role: 'user',
            content: { type: 'text', text: 'run this once across restarts' },
            messageIdentity: {
                v: 1,
                sessionId: session.id,
                messageId: 'durable-message-1',
            },
        };
        const captured = {
            id: 'row-1',
            seq: 1,
            localId: 'durable-message-1',
            content: { t: 'encrypted', c: encryptContent(session, prompt) },
            createdAt: 1,
            updatedAt: 1,
        };

        (first as any).processIncomingEncryptedMessage(captured, true);
        expect(firstCallback).toHaveBeenCalledTimes(1);

        const afterRestart = new ApiSessionClient('fake-token', session);
        const restartedCallback = vi.fn();
        afterRestart.onUserMessage(restartedCallback);
        (afterRestart as any).processIncomingEncryptedMessage(
            { ...captured, id: 'relay-rewrapped', seq: 999 },
            true,
        );

        expect(restartedCallback).not.toHaveBeenCalled();
    });

    it('rejects an identity-less ciphertext replay after reconstruction', () => {
        const first = new ApiSessionClient('fake-token', session);
        const prompt = {
            role: 'user',
            content: { type: 'text', text: 'legacy prompt once across restarts' },
        };
        const captured = {
            id: 'row-1',
            seq: 1,
            localId: null,
            content: { t: 'encrypted', c: encryptContent(session, prompt) },
            createdAt: 1,
            updatedAt: 1,
        };

        (first as any).processIncomingEncryptedMessage(captured, true);
        const afterRestart = new ApiSessionClient('fake-token', session);
        const restartedCallback = vi.fn();
        afterRestart.onUserMessage(restartedCallback);
        (afterRestart as any).processIncomingEncryptedMessage(
            { ...captured, id: 'relay-rewrapped', seq: 999 },
            true,
        );

        expect(restartedCallback).not.toHaveBeenCalled();
    });

    it('fails closed at durable replay capacity without evicting accepted work', () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).incomingReplayStore = new DurableIncomingMessageReplayStore({
            directory: join(idleHomeDir, 'bounded-message-replay-v1'),
            maxEntriesPerScope: 1,
        });
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        const makeCaptured = (messageId: string, seq: number) => {
            const prompt = {
                role: 'user',
                content: { type: 'text', text: messageId },
                messageIdentity: {
                    v: 1,
                    sessionId: session.id,
                    messageId,
                },
            };
            return {
                id: `row-${seq}`,
                seq,
                localId: messageId,
                content: { t: 'encrypted', c: encryptContent(session, prompt) },
                createdAt: seq,
                updatedAt: seq,
            };
        };
        const accepted = makeCaptured('accepted-message', 1);

        (client as any).processIncomingEncryptedMessage(accepted, true);
        expect(() => (client as any).processIncomingEncryptedMessage(
            makeCaptured('overflow-message', 2),
            true,
        )).toThrow('Incoming message replay protection is saturated');
        (client as any).processIncomingEncryptedMessage(
            { ...accepted, id: 'replayed-row', seq: 3 },
            true,
        );

        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it('invalidates receive sync and fetches on seq gap', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 1;

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(3, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'gap' }
        })));

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(1);
    });

    it('applies first live new-message update directly when lastSeq is 0', async () => {
        const client = new ApiSessionClient('fake-token', session);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        const firstMessage = {
            role: 'user',
            content: { type: 'text', text: 'first' }
        };

        try {
            emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, firstMessage)));

            expect(onUserMessage).toHaveBeenCalledTimes(1);
            expect(onUserMessage).toHaveBeenCalledWith(firstMessage);
            expect((client as any).lastSeq).toBe(1);
            expect(mockAxiosGet).not.toHaveBeenCalled();
        } finally {
            await client.close();
        }
    });

    it('invalidates receive sync for duplicate and stale seq values', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 5;

        mockAxiosGet.mockResolvedValue({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(5, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'duplicate' }
        })));
        emitSocketEvent('update', createNewMessageUpdate(4, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'stale' }
        })));

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(2);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.after_seq).toBe(5);
        expect(mockAxiosGet.mock.calls[1][1].params.after_seq).toBe(5);
    });

    it('updates lastSeq after successful outbox flush and never moves it backward', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 10;

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-9', seq: 9, localId: 'l9', createdAt: 9, updatedAt: 9 }]
            }
        });

        client.sendCodexMessage({ type: 'older' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });
        expect((client as any).lastSeq).toBe(10);

        mockAxiosPost.mockResolvedValueOnce({
            data: {
                messages: [{ id: 'msg-11', seq: 11, localId: 'l11', createdAt: 11, updatedAt: 11 }]
            }
        });

        client.sendCodexMessage({ type: 'newer' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(2);
        });
        expect((client as any).lastSeq).toBe(11);
    });

    it('flushOutbox tolerates missing response.data.messages and keeps lastSeq unchanged', async () => {
        const client = new ApiSessionClient('fake-token', session);
        (client as any).lastSeq = 7;

        mockAxiosPost.mockResolvedValueOnce({
            data: {}
        });

        client.sendCodexMessage({ type: 'no-messages-field' });
        await waitForCheck(() => {
            expect(mockAxiosPost).toHaveBeenCalledTimes(1);
        });

        expect((client as any).lastSeq).toBe(7);
        expect((client as any).pendingOutbox).toHaveLength(0);
    });

    it('triggers receive catch-up fetch on socket reconnect', async () => {
        new ApiSessionClient('fake-token', session);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                messages: [],
                hasMore: false
            }
        });

        emitSocketEvent('connect');

        await waitForCheck(() => {
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        });
        expect(mockAxiosGet.mock.calls[0][1].params.before_seq).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('stops send and receive sync loops on close', async () => {
        const client = new ApiSessionClient('fake-token', session);
        await client.close();

        mockAxiosGet.mockResolvedValue({
            data: {
                messages: [],
                hasMore: false
            }
        });
        mockAxiosPost.mockResolvedValue({
            data: {
                messages: []
            }
        });

        emitSocketEvent('update', createNewMessageUpdate(1, encryptContent(session, {
            role: 'user',
            content: { type: 'text', text: 'after-close' }
        })));
        client.sendCodexMessage({ type: 'after-close-send' });

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(mockSocket.close).toHaveBeenCalledTimes(1);
        expect(mockAxiosGet).not.toHaveBeenCalled();
        expect(mockAxiosPost).not.toHaveBeenCalled();
    });
});
