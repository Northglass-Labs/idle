import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import {
    AuthenticatedMessageIdentitySchema,
    CoreUpdateContainerSchema,
    createAuthenticatedMessageIdentity,
    isBoundedEncryptedMessageCiphertext,
} from '@northglass/idle-wire';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import type { EncryptionVariant } from './api';
import { decryptSessionField } from './sessionFieldEncryption';

// --- Types ---

export type SessionClientOptions = {
    sessionId: string;
    encryptionKey: Uint8Array;
    encryptionVariant: EncryptionVariant;
    token: string;
    serverUrl: string;
    initialMetadata?: unknown | null;
    initialMetadataVersion?: number;
    initialAgentState?: unknown | null;
    initialAgentStateVersion?: number;
};

type SessionContentEnvelope = {
    role?: unknown;
    content?: unknown;
    requestId?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function ciphertextFingerprint(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
}

function checkIdleState(
    metadata: unknown | null,
    agentState: unknown | null,
): 'archived' | boolean {
    const meta = metadata as Record<string, unknown> | null;
    if (meta?.lifecycleState === 'archived') {
        return 'archived';
    }

    const state = agentState as Record<string, unknown> | null;
    if (!state) {
        return false;
    }
    const controlledByUser = state.controlledByUser === true;
    const requests = state.requests;
    const hasRequests = requests != null
        && typeof requests === 'object'
        && !Array.isArray(requests)
        && Object.keys(requests as Record<string, unknown>).length > 0;
    return !controlledByUser && !hasRequests;
}

function getTurnEvent(content: unknown): { type: 'turn-start' | 'turn-end'; turnId: string | null } | null {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return null;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'session') {
        return null;
    }

    const body = envelope.content as { turn?: unknown; ev?: { t?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }

    if (body.ev?.t !== 'turn-start' && body.ev?.t !== 'turn-end') {
        return null;
    }

    return {
        type: body.ev.t,
        turnId: typeof body.turn === 'string' ? body.turn : null,
    };
}

function isReadyEvent(content: unknown): boolean {
    if (content == null || typeof content !== 'object' || Array.isArray(content)) {
        return false;
    }

    const envelope = content as SessionContentEnvelope;
    if (envelope.role !== 'agent') {
        return false;
    }

    const body = envelope.content as { type?: unknown; data?: { type?: unknown } } | null;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return false;
    }

    return body.type === 'event' && body.data?.type === 'ready';
}

function getAuthenticatedRequestId(content: unknown): string | null {
    if (!isRecord(content)) {
        return null;
    }
    const requestId = content.requestId;
    return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128
        ? requestId
        : null;
}

// --- SessionClient ---

export class SessionClient extends EventEmitter {
    readonly sessionId: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: EncryptionVariant;
    private socket: Socket;
    private metadata: unknown | null = null;
    private metadataVersion = 0;
    private agentState: unknown | null = null;
    private agentStateVersion = 0;
    private lastMessageSeq = 0;
    private readonly seenMessageCiphertexts = new Set<string>();
    private readonly seenMetadataCiphertexts = new Set<string>();
    private readonly seenAgentStateCiphertexts = new Set<string>();

    constructor(opts: SessionClientOptions) {
        super();
        this.sessionId = opts.sessionId;
        this.encryptionKey = opts.encryptionKey;
        this.encryptionVariant = opts.encryptionVariant;
        if (opts.initialMetadata !== undefined) {
            this.metadata = opts.initialMetadata;
        }
        if (Number.isSafeInteger(opts.initialMetadataVersion) && opts.initialMetadataVersion! >= 0) {
            this.metadataVersion = opts.initialMetadataVersion!;
        }
        if (opts.initialAgentState !== undefined) {
            this.agentState = opts.initialAgentState;
        }
        if (Number.isSafeInteger(opts.initialAgentStateVersion) && opts.initialAgentStateVersion! >= 0) {
            this.agentStateVersion = opts.initialAgentStateVersion!;
        }

        // Prevent unhandled 'error' event from crashing the process
        this.on('error', () => {});

        this.socket = io(opts.serverUrl, {
            auth: {
                token: opts.token,
                clientType: 'session-scoped' as const,
                sessionId: opts.sessionId,
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            autoConnect: false,
        });

        this.socket.on('connect', () => {
            this.emit('connected');
        });

        this.socket.on('disconnect', (reason: string) => {
            this.emit('disconnected', reason);
        });

        this.socket.on('connect_error', (error: Error) => {
            this.emit('connect_error', error);
        });

        this.socket.on('update', (data: unknown) => {
            try {
                const update = CoreUpdateContainerSchema.safeParse(data);
                if (!update.success) return;
                const body = update.data.body;

                if (
                    body.t === 'new-message'
                    && body.sid === this.sessionId
                    && body.message?.content?.t === 'encrypted'
                ) {
                    const msg = body.message;
                    if (
                        !isPositiveSafeInteger(msg.seq)
                        || msg.seq <= this.lastMessageSeq
                        || typeof msg.content.c !== 'string'
                        || !isBoundedEncryptedMessageCiphertext(msg.content.c)
                    ) {
                        return;
                    }
                    const fingerprint = ciphertextFingerprint(msg.content.c);
                    if (this.seenMessageCiphertexts.has(fingerprint)) {
                        return;
                    }
                    const decrypted = decrypt(
                        this.encryptionKey,
                        this.encryptionVariant,
                        decodeBase64(msg.content.c),
                    );
                    if (decrypted === null) return;
                    if (isRecord(decrypted) && Object.hasOwn(decrypted, 'messageIdentity')) {
                        const identity = AuthenticatedMessageIdentitySchema.safeParse(
                            decrypted.messageIdentity,
                        );
                        if (
                            !identity.success
                            || identity.data.sessionId !== this.sessionId
                            || identity.data.messageId !== msg.localId
                        ) {
                            return;
                        }
                    }
                    this.lastMessageSeq = msg.seq;
                    this.seenMessageCiphertexts.add(fingerprint);
                    this.emit('message', {
                        id: msg.id,
                        seq: msg.seq,
                        content: decrypted,
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        updatedAt: msg.updatedAt,
                    });
                } else if (body.t === 'update-session' && body.id === this.sessionId) {
                    let appliedState = false;
                    if (
                        body.metadata
                        && isPositiveSafeInteger(body.metadata.version)
                        && body.metadata.version > this.metadataVersion
                        && typeof body.metadata.value === 'string'
                        && isBoundedEncryptedMessageCiphertext(body.metadata.value)
                    ) {
                        const fingerprint = ciphertextFingerprint(body.metadata.value);
                        if (!this.seenMetadataCiphertexts.has(fingerprint)) {
                            const decrypted = decryptSessionField(
                                { key: this.encryptionKey, variant: this.encryptionVariant },
                                this.sessionId,
                                'metadata',
                                body.metadata.version,
                                body.metadata.value,
                            );
                            if (decrypted.success) {
                                this.metadata = decrypted.value;
                                this.metadataVersion = body.metadata.version;
                                this.seenMetadataCiphertexts.add(fingerprint);
                                appliedState = true;
                            }
                        }
                    }
                    if (
                        body.agentState
                        && isPositiveSafeInteger(body.agentState.version)
                        && body.agentState.version > this.agentStateVersion
                    ) {
                        if (
                            typeof body.agentState.value === 'string'
                            && isBoundedEncryptedMessageCiphertext(body.agentState.value)
                        ) {
                            const fingerprint = ciphertextFingerprint(body.agentState.value);
                            if (!this.seenAgentStateCiphertexts.has(fingerprint)) {
                                const decrypted = decryptSessionField(
                                    { key: this.encryptionKey, variant: this.encryptionVariant },
                                    this.sessionId,
                                    'agentState',
                                    body.agentState.version,
                                    body.agentState.value,
                                );
                                if (decrypted.success) {
                                    this.agentState = decrypted.value;
                                    this.agentStateVersion = body.agentState.version;
                                    this.seenAgentStateCiphertexts.add(fingerprint);
                                    appliedState = true;
                                }
                            }
                        }
                    }
                    if (appliedState) {
                        this.emit('state-change', {
                            metadata: this.metadata,
                            agentState: this.agentState,
                        });
                    }
                }
            } catch (err) {
                this.emit('error', err);
            }
        });

        this.socket.connect();
    }

    private emitMessage(text: string, meta: Record<string, unknown> | undefined, localId: string): void {
        const content = {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
            meta: {
                sentFrom: 'idle-agent',
                ...meta,
            },
            messageIdentity: createAuthenticatedMessageIdentity(this.sessionId, localId),
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted,
            localId,
        });
    }

    sendMessage(text: string, meta?: Record<string, unknown>): string {
        const localId = randomUUID();
        this.emitMessage(text, meta, localId);
        return localId;
    }

    sendMessageAndWait(
        text: string,
        meta?: Record<string, unknown>,
        timeoutMs = 300_000,
    ): Promise<void> {
        if (checkIdleState(this.metadata, this.agentState) === 'archived') {
            return Promise.reject(
                new Error('Session was archived while waiting for agent turn completion'),
            );
        }
        const localId = randomUUID();
        const completion = this.waitForTurnCompletion(localId, timeoutMs);
        this.emitMessage(text, meta, localId);
        return completion;
    }

    getMetadata(): unknown | null {
        return this.metadata;
    }

    getAgentState(): unknown | null {
        return this.agentState;
    }

    waitForConnect(timeoutMs = 10_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.socket.connected) {
                resolve();
                return;
            }
            const timeout = setTimeout(() => {
                this.removeListener('connected', onConnect);
                this.removeListener('connect_error', onError);
                reject(new Error('Timeout waiting for socket connection'));
            }, timeoutMs);
            const onConnect = () => {
                clearTimeout(timeout);
                this.removeListener('connect_error', onError);
                resolve();
            };
            const onError = (err: Error) => {
                clearTimeout(timeout);
                this.removeListener('connected', onConnect);
                reject(err);
            };
            this.once('connected', onConnect);
            this.once('connect_error', onError);
        });
    }

    waitForIdle(timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnected', onDisconnect);
            };

            const result = checkIdleState(this.metadata, this.agentState);
            if (result === 'archived') {
                reject(new Error('Session is archived'));
                return;
            }
            if (result === true) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Timeout waiting for agent to become idle'));
            }, timeoutMs);

            const onStateChange = () => {
                const r = checkIdleState(this.metadata, this.agentState);
                if (r === 'archived') {
                    cleanup();
                    reject(new Error('Session is archived'));
                } else if (r === true) {
                    cleanup();
                    resolve();
                }
            };

            const onDisconnect = () => {
                cleanup();
                reject(new Error('Socket disconnected while waiting for agent to become idle'));
            };

            this.on('state-change', onStateChange);
            this.on('disconnected', onDisconnect);
        });
    }

    waitForTurnCompletion(expectedRequestId: string, timeoutMs = 300_000): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let activeTurnId: string | null = null;
            let sawTurnStart = false;

            const cleanup = () => {
                clearTimeout(timeout);
                this.removeListener('message', onMessage);
                this.removeListener('state-change', onStateChange);
                this.removeListener('disconnected', onDisconnect);
            };

            const finish = (error?: Error) => {
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            const timeout = setTimeout(() => {
                finish(new Error('Timeout waiting for agent turn completion'));
            }, timeoutMs);

            const onStateChange = () => {
                if (checkIdleState(this.metadata, this.agentState) === 'archived') {
                    finish(new Error('Session was archived while waiting for agent turn completion'));
                }
            };

            const onMessage = (message: { content: unknown }) => {
                if (getAuthenticatedRequestId(message.content) !== expectedRequestId) {
                    return;
                }

                const turnEvent = getTurnEvent(message.content);
                if (turnEvent) {
                    if (turnEvent.type === 'turn-start') {
                        sawTurnStart = true;
                        activeTurnId = turnEvent.turnId;
                        return;
                    }

                    if (sawTurnStart && turnEvent.turnId === activeTurnId) {
                        finish();
                    }
                    return;
                }

                if (isReadyEvent(message.content)) {
                    finish();
                    return;
                }
            };

            const onDisconnect = () => {
                finish(new Error('Socket disconnected while waiting for agent turn completion'));
            };

            this.on('message', onMessage);
            this.on('state-change', onStateChange);
            this.on('disconnected', onDisconnect);

            onStateChange();
        });
    }

    sendStop(): void {
        this.socket.emit('session-end', {
            sid: this.sessionId,
            time: Date.now(),
        });
    }

    close(): void {
        this.socket.close();
    }
}
