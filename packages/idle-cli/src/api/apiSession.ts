import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, FileEventMessage, FileEventMessageSchema, Metadata, ServerToClientEvents, Session, Update, UserMessage, UserMessageSchema, Usage } from './types'
import { decodeBase64, decryptBlob, decrypt, encodeBase64, encrypt, encryptBlob } from './encryption';
import { decryptSessionField, encryptSessionField } from './sessionFieldEncryption';
import { backoff, delay } from '@/utils/time';
import { configuration } from '@/configuration';
import { RawJSONLines } from '@/claude/types';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AsyncLock } from '@/utils/lock';
import { deriveKey } from '@/utils/deriveKey';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { DurableIncomingMessageReplayStore } from './messages/DurableIncomingMessageReplayStore';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost, normalizeClaudeModelId } from '@/utils/pricing';
import { shouldReconnect } from '@/utils/lidState';
import {
    AuthenticatedMessageIdentitySchema,
    MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS,
    createEnvelope,
    SessionMessageSchema,
    splitMessageIngressBatches,
    type CreateEnvelopeOptions,
    type SessionEnvelope,
    type SessionTurnEndStatus,
} from '@northglass/idle-wire';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
    type ClaudeSessionProtocolState,
} from '@/claude/utils/sessionProtocolMapper';
import { InvalidateSync } from '@/utils/sync';
import axios from 'axios';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'claude' | 'opencode';

type V3SessionMessage = {
    id: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

type V3PostSessionMessagesResponse = {
    messages: Array<{
        id: string;
        seq: number;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }>;
};

type AttachmentUploadResult = {
    ref: string;
    uploadUrl: string;
    method?: 'PUT' | 'POST';
    formFields?: Record<string, string>;
};

type MessagePageDirection = 'forward' | 'backward';

type V3MessagePage = {
    messages: V3SessionMessage[];
    hasMore: boolean;
};

type BoundedMessageCollection = {
    status: 'complete' | 'truncated' | 'invalid';
    messages: V3SessionMessage[];
};

const SESSION_SYNC_PAGE_SIZE = 100;
const SESSION_SYNC_MAX_PAGES = 5;
const SESSION_SYNC_MAX_MESSAGES = SESSION_SYNC_PAGE_SIZE * SESSION_SYNC_MAX_PAGES;
const SESSION_SYNC_MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
const SESSION_SYNC_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const ATTACHMENT_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_URL_MAX_CHARACTERS = 16 * 1024;
const ATTACHMENT_REF_MAX_CHARACTERS = 2048;
const ATTACHMENT_FORM_MAX_FIELDS = 64;
const ATTACHMENT_FORM_KEY_MAX_CHARACTERS = 256;
const ATTACHMENT_FORM_VALUE_MAX_CHARACTERS = 16 * 1024;
const ATTACHMENT_FORM_TOTAL_MAX_BYTES = 64 * 1024;

export type LocalImageAttachment = {
    data: Uint8Array;
    mimeType: string;
    name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseCredentialFreeHttpUrl(rawUrl: string): URL | null {
    if (
        rawUrl.length === 0
        || rawUrl.length > ATTACHMENT_URL_MAX_CHARACTERS
        || rawUrl !== rawUrl.trim()
    ) {
        return null;
    }
    try {
        const parsed = new URL(rawUrl);
        if (
            (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
            || parsed.username.length > 0
            || parsed.password.length > 0
            || parsed.hash.length > 0
        ) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

type AttachmentTransferKind = 'upload-post' | 'upload-put' | 'download';

const TRUSTED_OBJECT_STORAGE_HOSTS = [
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)?s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/,
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)?storage\.googleapis\.com$/,
    /^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/,
    /^[a-z0-9-]+\.blob\.core\.windows\.net$/,
    /^(?:[a-z0-9-]+\.){1,2}digitaloceanspaces\.com$/,
    /^s3[.-][a-z0-9-]+\.backblazeb2\.com$/,
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)?s3[.-][a-z0-9-]+\.wasabisys\.com$/,
];

function validateAttachmentTransferUrl(
    rawUrl: string,
    kind: AttachmentTransferKind,
): { url: string; sendBearer: boolean } {
    const relay = parseCredentialFreeHttpUrl(configuration.serverUrl);
    const target = parseCredentialFreeHttpUrl(rawUrl);
    if (!relay || !target) {
        throw new Error('Attachment transfer URL is not allowed');
    }

    if (target.origin === relay.origin) {
        if (kind === 'upload-post') {
            throw new Error('Attachment transfer URL is not allowed');
        }
        return { url: target.href, sendBearer: true };
    }

    const trustedObjectStorage = target.protocol === 'https:'
        && target.port === ''
        && TRUSTED_OBJECT_STORAGE_HOSTS.some((pattern) => (
            pattern.test(target.hostname.toLowerCase())
        ));
    if (!trustedObjectStorage || kind === 'upload-put') {
        throw new Error('Attachment transfer URL is not allowed');
    }

    return { url: target.href, sendBearer: false };
}

function validateAttachmentFormFields(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error('request-upload returned an invalid response');
    const entries = Object.entries(value);
    if (entries.length > ATTACHMENT_FORM_MAX_FIELDS) {
        throw new Error('request-upload returned an invalid response');
    }
    let totalBytes = 0;
    const fields: Record<string, string> = {};
    for (const [key, entry] of entries) {
        if (
            typeof entry !== 'string'
            || key.length === 0
            || key.length > ATTACHMENT_FORM_KEY_MAX_CHARACTERS
            || entry.length > ATTACHMENT_FORM_VALUE_MAX_CHARACTERS
        ) {
            throw new Error('request-upload returned an invalid response');
        }
        totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(entry, 'utf8');
        if (totalBytes > ATTACHMENT_FORM_TOTAL_MAX_BYTES) {
            throw new Error('request-upload returned an invalid response');
        }
        fields[key] = entry;
    }
    return fields;
}

function errorLogMetadata(error: unknown): { errorType: string } {
    if (error instanceof Error) return { errorType: 'error' };
    if (error === null) return { errorType: 'null' };
    if (Array.isArray(error)) return { errorType: 'array' };
    return { errorType: typeof error };
}

function agentStateLogMetadata(state: AgentState | null): {
    hasState: boolean;
    controlledByUser: boolean | null;
    pendingRequestCount: number;
    completedRequestCount: number;
    hasGoalStatus: boolean;
} {
    return {
        hasState: state !== null,
        controlledByUser: typeof state?.controlledByUser === 'boolean' ? state.controlledByUser : null,
        pendingRequestCount: state?.requests ? Object.keys(state.requests).length : 0,
        completedRequestCount: state?.completedRequests ? Object.keys(state.completedRequests).length : 0,
        hasGoalStatus: state?.agentGoalStatus !== undefined,
    };
}

function socketUpdateLogMetadata(update: Update): {
    updateType: 'new-message' | 'update-session' | 'update-machine' | 'unknown';
    hasBody: boolean;
} {
    const body = isRecord(update.body) ? update.body : null;
    const updateType = body?.t === 'new-message'
        || body?.t === 'update-session'
        || body?.t === 'update-machine'
        ? body.t
        : 'unknown';
    return { updateType, hasBody: body !== null };
}

function parseV3MessagePage(
    data: unknown,
    direction: MessagePageDirection,
    cursor: number,
    maxMessages: number,
): V3MessagePage | null {
    if (
        !isRecord(data)
        || !Array.isArray(data.messages)
        || data.messages.length > maxMessages
        || typeof data.hasMore !== 'boolean'
    ) {
        return null;
    }

    const messagesBySeq = new Map<number, V3SessionMessage>();
    for (const value of data.messages) {
        const parsed = SessionMessageSchema.safeParse(value);
        if (!parsed.success || !Number.isSafeInteger(parsed.data.seq) || parsed.data.seq < 1) {
            return null;
        }

        const isFresh = direction === 'forward'
            ? parsed.data.seq > cursor
            : parsed.data.seq < cursor;
        if (!isFresh) {
            continue;
        }
        if (messagesBySeq.has(parsed.data.seq)) {
            return null;
        }

        messagesBySeq.set(parsed.data.seq, {
            ...parsed.data,
            localId: parsed.data.localId ?? null,
        });
    }

    const messages = [...messagesBySeq.values()];
    messages.sort((left, right) => (
        direction === 'forward' ? left.seq - right.seq : right.seq - left.seq
    ));
    return { messages, hasMore: data.hasMore };
}

function extensionForImageMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/gif':
            return 'gif';
        case 'image/webp':
            return 'webp';
        case 'image/png':
        default:
            return 'png';
    }
}

function extractLocalTranscriptImageAttachments(body: RawJSONLines): LocalImageAttachment[] {
    if (body.type !== 'user' || body.isMeta || body.isSidechain) {
        return [];
    }

    const content = (body as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) {
        return [];
    }

    // Tool results are user-role messages from Claude's protocol, but they
    // represent agent tool lifecycle, not human multimodal input.
    if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
        return [];
    }

    const attachments: LocalImageAttachment[] = [];
    for (const block of content) {
        if (!isRecord(block) || block.type !== 'image') {
            continue;
        }
        const source = block.source;
        if (!isRecord(source) || source.type !== 'base64' || typeof source.data !== 'string') {
            continue;
        }

        const data = decodeBase64(source.data);
        if (data.length === 0) {
            continue;
        }

        const mimeType = typeof source.media_type === 'string' && source.media_type.startsWith('image/')
            ? source.media_type
            : 'image/png';
        const index = attachments.length + 1;
        attachments.push({
            data,
            mimeType,
            name: `claude-image-${index}.${extensionForImageMime(mimeType)}`,
        });
    }

    return attachments;
}

function escapeMultipartValue(value: string): string {
    return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('"', '%22');
}

function buildMultipartUploadBody(
    fields: Record<string, string> | undefined,
    data: Uint8Array,
): { body: Buffer; boundary: string } {
    const boundary = `----idle-cli-${randomUUID()}`;
    const chunks: Buffer[] = [];

    for (const [key, value] of Object.entries(fields ?? {})) {
        chunks.push(Buffer.from(
            `--${boundary}\r\n`
            + `Content-Disposition: form-data; name="${escapeMultipartValue(key)}"\r\n\r\n`
            + `${value}\r\n`,
            'utf8',
        ));
    }

    chunks.push(Buffer.from(
        `--${boundary}\r\n`
        + 'Content-Disposition: form-data; name="file"; filename="blob"\r\n'
        + 'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
    ));
    chunks.push(Buffer.from(data));
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

    return {
        body: Buffer.concat(chunks),
        boundary,
    };
}

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    private readonly rpcRegistrationToken: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private pendingFileEvents: FileEventMessage[] = [];
    private pendingFileEventCallback: ((data: FileEventMessage) => void) | null = null;
    private blobKey: Uint8Array | null = null;
    /**
     * In-flight attachment download promises that belong to the *current*
     * (not-yet-drained) batch. Each promise resolves to the decoded blob (or
     * null on failure), so per-message ownership is intrinsic — there is no
     * shared push-array between batches that a late download could leak into.
     */
    private pendingDownloads: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>[] = [];
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private reconnectInterval: NodeJS.Timeout | null = null;
    private ignoreArchiveSignal = false;
    private skipInitialMessages = false;
    private claudeSessionProtocolState: ClaudeSessionProtocolState = {
        currentTurnId: null,
        uuidToProviderSubagent: new Map<string, string>(),
        taskPromptToSubagents: new Map<string, string[]>(),
        providerSubagentToSessionSubagent: new Map<string, string>(),
        subagentTitles: new Map<string, string>(),
        bufferedSubagentMessages: new Map<string, RawJSONLines[]>(),
        hiddenParentToolCalls: new Set<string>(),
        startedSubagents: new Set<string>(),
        activeSubagents: new Set<string>(),
    };
    private lastSeq = 0;
    private readonly incomingReplayStore: DurableIncomingMessageReplayStore;
    private readonly incomingReplayScope: string;
    private pendingOutbox: Array<{ content: string; localId: string }> = [];
    private activeRequestId: string | null = null;
    private readonly sendSync: InvalidateSync;
    private readonly receiveSync: InvalidateSync;

    constructor(token: string, session: Session, rpcRegistrationToken: string = token) {
        super()
        this.token = token;
        this.rpcRegistrationToken = rpcRegistrationToken;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        const keyEpoch = createHash('sha256')
            .update('idle-message-key-epoch-v1\0')
            .update(this.encryptionVariant)
            .update('\0')
            .update(this.encryptionKey)
            .digest('base64url');
        this.incomingReplayScope = `${this.sessionId}:${keyEpoch}`;
        this.incomingReplayStore = new DurableIncomingMessageReplayStore({
            directory: join(configuration.idleHomeDir, 'message-replay-v1'),
        });
        this.sendSync = new InvalidateSync(() => this.flushOutbox());
        this.receiveSync = new InvalidateSync(() => this.fetchMessages());

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, { hasMetadata: data !== undefined })
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = io(configuration.serverUrl, {
            auth: {
                token: this.rpcRegistrationToken,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId,
                happyClient: `cli-coding-session/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.receiveSync.invalidate();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected', { hasReason: typeof reason === 'string' && reason.length > 0 });
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error', errorLogMetadata(error));
            this.rpcHandlerManager.onSocketDisconnect();
            this.startSmartReconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debug('[SOCKET] [UPDATE] Received update', socketUpdateLogMetadata(data));

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message') {
                    const message = data.body.message;
                    const messageSeq = message?.seq;
                    if (!message || typeof messageSeq !== 'number' || messageSeq !== this.lastSeq + 1 || message.content.t !== 'encrypted') {
                        this.receiveSync.invalidate();
                        return;
                    }
                    try {
                        this.processIncomingEncryptedMessage({
                            ...message,
                            localId: message.localId ?? null,
                        }, true);
                    } catch (error) {
                        logger.debug('[SOCKET] [UPDATE] Failed to process encrypted message', {
                            seq: messageSeq,
                            ...errorLogMetadata(error),
                        });
                    }
                    this.lastSeq = messageSeq;
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        const decrypted = decryptSessionField<Metadata>(
                            { key: this.encryptionKey, variant: this.encryptionVariant },
                            this.sessionId,
                            'metadata',
                            data.body.metadata.version,
                            data.body.metadata.value,
                        );
                        if (!decrypted.success) {
                            this.receiveSync.invalidate();
                            return;
                        }
                        this.metadata = decrypted.value;
                        this.metadataVersion = data.body.metadata.version;
                        // Check if session was archived from web/mobile
                        const meta = this.metadata as any;
                        if (meta?.lifecycleState === 'archiveRequested' || meta?.lifecycleState === 'archived') {
                            if (this.ignoreArchiveSignal) {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}) but suppressed for reconnect`);
                                this.ignoreArchiveSignal = false;
                            } else {
                                logger.debug(`[SOCKET] Session archived (${meta.lifecycleState}), exiting...`);
                                this.emit('archived');
                            }
                        }
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        const decrypted = decryptSessionField<AgentState>(
                            { key: this.encryptionKey, variant: this.encryptionVariant },
                            this.sessionId,
                            'agentState',
                            data.body.agentState.version,
                            data.body.agentState.value,
                        );
                        if (!decrypted.success) {
                            this.receiveSync.invalidate();
                            return;
                        }
                        this.agentState = decrypted.value;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', errorLogMetadata(error));
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error', errorLogMetadata(error));
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    onFileEvent(callback: (data: FileEventMessage) => void) {
        this.pendingFileEventCallback = callback;
        while (this.pendingFileEvents.length > 0) {
            callback(this.pendingFileEvents.shift()!);
        }
    }

    /**
     * Derive (and cache) the blob decryption key for this session.
     * Legacy sessions use deriveKey(masterSecret, 'Happy Blobs', ['master']).
     * DataKey sessions use deriveKey(dataKey, 'Happy Blobs', ['session']).
     */
    async getBlobKey(): Promise<Uint8Array> {
        if (!this.blobKey) {
            const path = this.encryptionVariant === 'dataKey' ? ['session'] : ['master'];
            this.blobKey = await deriveKey(this.encryptionKey, 'Happy Blobs', path);
        }
        return this.blobKey;
    }

    private async requestAttachmentUpload(filename: string, size: number): Promise<AttachmentUploadResult> {
        const response = await axios.post<AttachmentUploadResult>(
            `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/attachments/request-upload`,
            { filename, size },
            {
                headers: this.authHeaders(),
                timeout: 30000,
                maxContentLength: ATTACHMENT_CONTROL_RESPONSE_MAX_BYTES,
                maxRedirects: 0,
            },
        );

        const upload = response.data;
        if (
            !upload
            || typeof upload.ref !== 'string'
            || upload.ref.length === 0
            || upload.ref.length > ATTACHMENT_REF_MAX_CHARACTERS
            || typeof upload.uploadUrl !== 'string'
            || (upload.method !== undefined && upload.method !== 'PUT' && upload.method !== 'POST')
        ) {
            throw new Error('request-upload returned an invalid response');
        }

        const method = upload.method ?? 'PUT';
        const transfer = validateAttachmentTransferUrl(
            upload.uploadUrl,
            method === 'POST' ? 'upload-post' : 'upload-put',
        );
        const formFields = validateAttachmentFormFields(upload.formFields);

        return {
            ref: upload.ref,
            uploadUrl: transfer.url,
            method,
            ...(formFields ? { formFields } : {}),
        };
    }

    private async uploadEncryptedAttachmentBlob(upload: AttachmentUploadResult, encrypted: Uint8Array): Promise<void> {
        const transfer = validateAttachmentTransferUrl(
            upload.uploadUrl,
            upload.method === 'POST' ? 'upload-post' : 'upload-put',
        );
        if (upload.method === 'POST') {
            const { body, boundary } = buildMultipartUploadBody(upload.formFields, encrypted);
            await axios.post(transfer.url, body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                timeout: 60000,
                maxBodyLength: ATTACHMENT_TRANSFER_MAX_BYTES,
                maxContentLength: ATTACHMENT_CONTROL_RESPONSE_MAX_BYTES,
                maxRedirects: 0,
            });
            return;
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
        };
        if (transfer.sendBearer) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        await axios.put(transfer.url, Buffer.from(encrypted), {
            headers,
            timeout: 60000,
            maxBodyLength: ATTACHMENT_TRANSFER_MAX_BYTES,
            maxContentLength: ATTACHMENT_CONTROL_RESPONSE_MAX_BYTES,
            maxRedirects: 0,
        });
    }

    async uploadLocalImageAttachmentEnvelope(
        attachment: LocalImageAttachment,
        opts: Pick<CreateEnvelopeOptions, 'id' | 'time' | 'claudeUuid' | 'codexItemId'> = {},
    ): Promise<SessionEnvelope> {
        const blobKey = await this.getBlobKey();
        const encrypted = encryptBlob(attachment.data, blobKey);
        const upload = await this.requestAttachmentUpload(attachment.name, encrypted.length);
        await this.uploadEncryptedAttachmentBlob(upload, encrypted);

        return createEnvelope('user', {
            t: 'file',
            ref: upload.ref,
            name: attachment.name,
            size: attachment.data.length,
            mimeType: attachment.mimeType,
        }, opts);
    }

    /**
     * Download an encrypted attachment blob via the request-download flow:
     * POST /request-download → { downloadUrl } → GET downloadUrl. Local mode
     * downloadUrl points back at our server (Bearer required); S3 mode is a
     * presigned URL that does not accept extra headers.
     */
    async downloadAttachment(ref: string): Promise<Uint8Array> {
        const requestUrl = `${configuration.serverUrl}/v1/sessions/${this.sessionId}/attachments/request-download`;
        const requestRes = await axios.post(
            requestUrl,
            { ref },
            {
                headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
                maxContentLength: ATTACHMENT_CONTROL_RESPONSE_MAX_BYTES,
                maxRedirects: 0,
            },
        );
        const downloadUrl = requestRes.data?.downloadUrl;
        if (typeof downloadUrl !== 'string') {
            throw new Error('request-download returned no downloadUrl');
        }

        const transfer = validateAttachmentTransferUrl(downloadUrl, 'download');
        const headers: Record<string, string> = {};
        if (transfer.sendBearer) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        const response = await axios.get(transfer.url, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 0,
            maxContentLength: ATTACHMENT_TRANSFER_MAX_BYTES,
        });
        const data = response.data;
        if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
            throw new Error('Attachment download returned invalid data');
        }
        const bytes = data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes.byteLength > ATTACHMENT_TRANSFER_MAX_BYTES) {
            throw new Error('Attachment download exceeded the size limit');
        }
        return new Uint8Array(bytes);
    }

    /**
     * Download and decrypt an attachment blob.
     * Returns the decrypted binary data or null if decryption fails.
     */
    async downloadAndDecryptAttachment(ref: string): Promise<Uint8Array | null> {
        const encrypted = await this.downloadAttachment(ref);
        const key = await this.getBlobKey();
        const decrypted = decryptBlob(encrypted, key);
        return decrypted;
    }

    /**
     * Track an attachment download whose promise resolves to the decoded blob
     * (or null on failure). The download stays in the current batch until the
     * next drainAttachmentsForUserMessage call swaps the bucket out — file
     * events that arrive after the swap go into a fresh bucket bound to the
     * next user-text message.
     */
    trackAttachmentDownload(promise: Promise<{ data: Uint8Array; mimeType: string; name: string } | null>): void {
        this.pendingDownloads.push(promise);
    }

    /**
     * Atomically claim every download started before this call, wait for them
     * to resolve, and return the successful ones. The swap-then-await order
     * guarantees that a late-arriving file event cannot leak into this batch.
     */
    async drainAttachmentsForUserMessage(): Promise<Array<{ data: Uint8Array; mimeType: string; name: string }>> {
        const downloads = this.pendingDownloads;
        this.pendingDownloads = [];
        if (downloads.length === 0) return [];
        const results = await Promise.all(downloads);
        return results.filter((x): x is { data: Uint8Array; mimeType: string; name: string } => x !== null);
    }

    private authHeaders() {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`
        };
    }

    private routeIncomingMessage(message: unknown) {
        const userResult = UserMessageSchema.safeParse(message);
        if (userResult.success) {
            if (this.pendingMessageCallback) {
                this.pendingMessageCallback(userResult.data);
            } else {
                this.pendingMessages.push(userResult.data);
            }
            return;
        }

        // Check for file events (image attachments from app)
        const fileResult = FileEventMessageSchema.safeParse(message);
        if (fileResult.success) {
            const ev = fileResult.data.content.data.ev;
            logger.debug('[API] Received file event', {
                size: ev.size,
                hasMimeType: Boolean(ev.mimeType),
            });
            if (this.pendingFileEventCallback) {
                this.pendingFileEventCallback(fileResult.data);
            } else {
                this.pendingFileEvents.push(fileResult.data);
            }
            return;
        }

        this.emit('message', message);
    }

    private rememberIncomingReplayKey(key: string): boolean {
        const result = this.incomingReplayStore.consume(
            this.incomingReplayScope,
            key,
        );
        if (result === 'saturated') {
            throw new Error('Incoming message replay protection is saturated');
        }
        return result === 'consumed';
    }

    /**
     * Decrypt, authenticate sender-owned message identity, and apply replay
     * filtering before any message reaches the user-prompt or file router.
     * Both socket delivery and paginated catch-up use this boundary.
     */
    private processIncomingEncryptedMessage(message: V3SessionMessage, shouldRoute: boolean): void {
        const ciphertext = decodeBase64(message.content.c);
        const body = decrypt(
            this.encryptionKey,
            this.encryptionVariant,
            ciphertext,
        );
        if (!isRecord(body)) {
            throw new Error('Decrypted message body is invalid');
        }
        const requiresDurableReplayProtection = (
            UserMessageSchema.safeParse(body).success
            || FileEventMessageSchema.safeParse(body).success
        );

        const hasAuthenticatedIdentity = Object.prototype.hasOwnProperty.call(body, 'messageIdentity');
        let replayKey: string;
        if (hasAuthenticatedIdentity) {
            const identity = AuthenticatedMessageIdentitySchema.safeParse(body.messageIdentity);
            if (
                !identity.success
                || identity.data.sessionId !== this.sessionId
                || identity.data.messageId !== message.localId
            ) {
                logger.debug('[API] Rejected message with invalid authenticated identity', {
                    seq: message.seq,
                });
                return;
            }
            replayKey = `authenticated:${identity.data.messageId}`;
        } else {
            // Legacy clients did not include an authenticated identity. Preserve
            // compatibility while rejecting exact captured-ciphertext reuse;
            // unlike a plaintext hash, separately encrypted equal prompts remain
            // distinct because every supported cipher uses a fresh nonce.
            const ciphertextFingerprint = createHash('sha256')
                .update(ciphertext)
                .digest('base64url');
            replayKey = `legacy-ciphertext:${ciphertextFingerprint}`;
        }

        if (
            requiresDurableReplayProtection
            && !this.rememberIncomingReplayKey(replayKey)
        ) {
            logger.debug('[API] Ignored replayed encrypted message', {
                seq: message.seq,
            });
            return;
        }

        if (shouldRoute) {
            this.routeIncomingMessage(body);
        }
    }

    private async fetchMessagePage(
        direction: MessagePageDirection,
        cursor: number,
        limit: number,
    ): Promise<V3MessagePage | null> {
        const params = direction === 'forward'
            ? { after_seq: cursor, limit }
            : { before_seq: cursor, limit };
        let response;
        try {
            response = await axios.get<unknown>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    params,
                    headers: this.authHeaders(),
                    timeout: 60000,
                    maxContentLength: SESSION_SYNC_MAX_RESPONSE_BYTES,
                    maxRedirects: 0,
                },
            );
        } catch (error) {
            if (
                isRecord(error)
                && error.code === 'ERR_BAD_RESPONSE'
                && typeof error.message === 'string'
                && error.message.includes('maxContentLength')
            ) {
                logger.debug('[API] Message sync response exceeded the client size limit');
                return null;
            }
            throw error;
        }
        const page = parseV3MessagePage(response.data, direction, cursor, limit);
        if (!page) {
            logger.debug('[API] Message sync response rejected by schema or sequence validation');
        }
        return page;
    }

    private async collectForwardMessages(afterSeq: number): Promise<BoundedMessageCollection> {
        const messages: V3SessionMessage[] = [];
        let cursor = afterSeq;
        let ciphertextBytes = 0;

        for (let pageNumber = 0; pageNumber < SESSION_SYNC_MAX_PAGES; pageNumber += 1) {
            const page = await this.fetchMessagePage(
                'forward',
                cursor,
                Math.min(SESSION_SYNC_PAGE_SIZE, SESSION_SYNC_MAX_MESSAGES - messages.length),
            );
            if (!page) {
                return { status: 'invalid', messages: [] };
            }
            if (page.messages.length === 0) {
                if (page.hasMore) {
                    logger.debug('[API] Forward message pagination made no progress; stopping');
                }
                return { status: 'complete', messages };
            }

            const pageBytes = page.messages.reduce(
                (total, message) => total + Buffer.byteLength(message.content.c, 'utf8'),
                0,
            );
            if (ciphertextBytes + pageBytes > SESSION_SYNC_MAX_CIPHERTEXT_BYTES) {
                return { status: 'truncated', messages: [] };
            }

            messages.push(...page.messages);
            ciphertextBytes += pageBytes;
            cursor = page.messages[page.messages.length - 1].seq;
            if (!page.hasMore) {
                return { status: 'complete', messages };
            }
        }

        return { status: 'truncated', messages: [] };
    }

    private async collectRecentMessages(afterSeq: number): Promise<BoundedMessageCollection> {
        const newestFirst: V3SessionMessage[] = [];
        let cursor = Number.MAX_SAFE_INTEGER;
        let ciphertextBytes = 0;
        let truncated = false;

        for (let pageNumber = 0; pageNumber < SESSION_SYNC_MAX_PAGES; pageNumber += 1) {
            const page = await this.fetchMessagePage(
                'backward',
                cursor,
                Math.min(SESSION_SYNC_PAGE_SIZE, SESSION_SYNC_MAX_MESSAGES - newestFirst.length),
            );
            if (!page) {
                return { status: 'invalid', messages: [] };
            }
            if (page.messages.length === 0) {
                break;
            }

            let reachedExistingHistory = false;
            for (const message of page.messages) {
                if (message.seq <= afterSeq) {
                    reachedExistingHistory = true;
                    break;
                }

                const messageBytes = Buffer.byteLength(message.content.c, 'utf8');
                if (
                    newestFirst.length >= SESSION_SYNC_MAX_MESSAGES
                    || ciphertextBytes + messageBytes > SESSION_SYNC_MAX_CIPHERTEXT_BYTES
                ) {
                    truncated = true;
                    break;
                }
                newestFirst.push(message);
                ciphertextBytes += messageBytes;
            }

            if (truncated || reachedExistingHistory || !page.hasMore) {
                break;
            }
            if (pageNumber === SESSION_SYNC_MAX_PAGES - 1) {
                truncated = true;
                break;
            }
            cursor = page.messages[page.messages.length - 1].seq;
            if (newestFirst.length >= SESSION_SYNC_MAX_MESSAGES) {
                truncated = page.hasMore;
                break;
            }
        }

        newestFirst.sort((left, right) => left.seq - right.seq);
        return {
            status: truncated ? 'truncated' : 'complete',
            messages: newestFirst,
        };
    }

    private async fetchMessages() {
        // On reconnect, skip processing existing messages — just advance lastSeq
        const skipRouting = this.skipInitialMessages;
        if (skipRouting) {
            this.skipInitialMessages = false;
            logger.debug('[API] Reconnect mode: skipping existing messages, advancing lastSeq');
        }

        const startingSeq = this.lastSeq;
        let collection = startingSeq === 0
            ? await this.collectRecentMessages(startingSeq)
            : await this.collectForwardMessages(startingSeq);

        if (collection.status === 'invalid') {
            return;
        }
        if (collection.status === 'truncated' && startingSeq > 0) {
            logger.debug('[API] Forward catch-up exceeded sync limits; switching to recent history');
            collection = await this.collectRecentMessages(startingSeq);
            if (collection.status === 'invalid') {
                return;
            }
        }
        if (collection.status === 'truncated') {
            logger.debug('[API] Message history was bounded to the newest sync window');
        }

        for (const message of collection.messages) {
            if (message.seq <= this.lastSeq) {
                continue;
            }
            try {
                this.processIncomingEncryptedMessage(message, !skipRouting);
            } catch (error) {
                logger.debug('[API] Failed to process fetched message', {
                    seq: message.seq,
                    ...errorLogMetadata(error),
                });
            }
            this.lastSeq = message.seq;
        }
    }

    private static readonly MAX_OUTBOX_BATCH_SIZE = 50;

    private async flushOutbox() {
        // Send latest messages first so the user sees recent activity immediately,
        // then backfill older messages in subsequent batches.
        while (this.pendingOutbox.length > 0) {
            const batchSize = Math.min(this.pendingOutbox.length, ApiSessionClient.MAX_OUTBOX_BATCH_SIZE);
            const candidates = this.pendingOutbox.slice(this.pendingOutbox.length - batchSize);
            const batches = splitMessageIngressBatches(candidates);
            const batch = batches.at(-1)!;
            const batchStart = this.pendingOutbox.length - batch.length;

            const response = await axios.post<V3PostSessionMessagesResponse>(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                {
                    messages: batch
                },
                {
                    headers: this.authHeaders(),
                    timeout: 60000,
                    maxRedirects: 0,
                }
            );

            const messages = Array.isArray(response.data.messages) ? response.data.messages : [];
            const maxSeq = messages.reduce((acc, message) => (
                message.seq > acc ? message.seq : acc
            ), this.lastSeq);
            this.lastSeq = maxSeq;
            this.pendingOutbox.splice(batchStart, batch.length);
        }
    }

    setActiveRequestId(requestId: string | null | undefined): void {
        if (
            requestId !== null
            && requestId !== undefined
            && (requestId.length < 1 || requestId.length > MAX_AUTHENTICATED_MESSAGE_ID_CHARACTERS)
        ) {
            throw new Error('Active request ID is invalid');
        }
        this.activeRequestId = requestId ?? null;
    }

    getActiveRequestId(): string | null {
        return this.activeRequestId;
    }

    private enqueueMessage(content: unknown, invalidate: boolean = true) {
        const correlatedContent = this.activeRequestId && isRecord(content)
            ? { ...content, requestId: this.activeRequestId }
            : content;
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, correlatedContent));
        this.pendingOutbox.push({
            content: encrypted,
            localId: randomUUID()
        });
        if (invalidate) {
            this.sendSync.invalidate();
        }
    }

    private enqueueSessionProtocolEnvelopes(envelopes: SessionEnvelope[], invalidate: boolean = true) {
        for (let i = 0; i < envelopes.length; i += 1) {
            this.enqueueSessionProtocolEnvelope(envelopes[i], invalidate && i === envelopes.length - 1);
        }
    }

    private applyClaudeSessionMessageSideEffects(body: RawJSONLines) {
        if (body.type === 'assistant') {
            const model = normalizeClaudeModelId(body.message?.model);
            if (model && this.metadata?.currentModelCode !== model) {
                this.updateMetadata((metadata) => ({
                    ...metadata,
                    currentModelCode: model,
                }));
            }

            if (body.message?.usage) {
                try {
                    this.sendUsageData(body.message.usage, model ?? undefined);
                } catch (error) {
                    logger.debug('[SOCKET] Failed to send usage data', errorLogMetadata(error));
                }
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
        this.applyClaudeSessionMessageSideEffects(body);
    }

    async sendClaudeSessionMessageFromLocalTranscript(body: RawJSONLines): Promise<void> {
        const attachments = extractLocalTranscriptImageAttachments(body);
        if (attachments.length === 0) {
            this.sendClaudeSessionMessage(body);
            return;
        }

        const closeMapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, 'completed');
        this.claudeSessionProtocolState.currentTurnId = closeMapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(closeMapped.envelopes, false);

        const claudeUuid = typeof (body as { uuid?: unknown }).uuid === 'string'
            ? (body as { uuid: string }).uuid
            : undefined;
        for (const attachment of attachments) {
            try {
                const envelope = await this.uploadLocalImageAttachmentEnvelope(attachment, { claudeUuid });
                this.enqueueSessionProtocolEnvelope(envelope, false);
            } catch (error) {
                logger.debug('[API] Failed to upload local Claude transcript image attachment', {
                    byteLength: attachment.data.length,
                    hasMimeType: attachment.mimeType.length > 0,
                    ...errorLogMetadata(error),
                });
            }
        }

        const mapped = mapClaudeLogMessageToSessionEnvelopes(body, this.claudeSessionProtocolState);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes, mapped.envelopes.length > 0);
        if (mapped.envelopes.length === 0) {
            this.sendSync.invalidate();
        }
        this.applyClaudeSessionMessageSideEffects(body);
    }

    closeClaudeSessionTurn(status: SessionTurnEndStatus = 'completed') {
        const mapped = closeClaudeTurnWithStatus(this.claudeSessionProtocolState, status);
        this.claudeSessionProtocolState.currentTurnId = mapped.currentTurnId;
        this.enqueueSessionProtocolEnvelopes(mapped.envelopes);
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        this.enqueueMessage(content);
    }

    private enqueueSessionProtocolEnvelope(envelope: SessionEnvelope, invalidate: boolean = true) {
        const content = {
            role: 'session',
            content: envelope,
            meta: {
                sentFrom: 'cli'
            }
        };

        this.enqueueMessage(content, invalidate);
    }

    sendSessionProtocolMessage(envelope: SessionEnvelope) {
        if (envelope.role !== 'user') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        if (envelope.ev.t !== 'text') {
            this.enqueueSessionProtocolEnvelope(envelope);
            return;
        }

        this.enqueueSessionProtocolEnvelope(envelope);
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     *
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'gemini' | 'codex' | 'claude' | 'opencode' | 'openclaw', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        this.enqueueMessage(content);
    }

    sendSessionEvent(event: {
        type: 'switch', mode: 'local' | 'remote'
    } | {
        type: 'message', message: string
    } | {
        type: 'permission-mode-changed', mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    } | {
        type: 'ready'
    }, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        this.enqueueMessage(content);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        const costs = calculateCost(usage, model);
        if (!costs) {
            logger.debug('[SOCKET] Usage cost not reported', {
                hasModel: typeof model === 'string' && model.length > 0,
            });
            return;
        }

        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debug('[SOCKET] Sending usage data', {
            totalTokens,
            hasModel: typeof model === 'string' && model.length > 0,
        })
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Returns the latest session metadata known to the client.
     */
    getMetadata(): Metadata | null {
        return this.metadata;
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    suppressNextArchiveSignal() {
        this.ignoreArchiveSignal = true;
    }

    skipExistingMessages() {
        this.skipInitialMessages = true;
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.metadata!); // Weird state if metadata is null - should never happen but here we are
                const expectedVersion = this.metadataVersion;
                const metadata = encryptSessionField(
                    { key: this.encryptionKey, variant: this.encryptionVariant },
                    this.sessionId,
                    'metadata',
                    expectedVersion + 1,
                    updated,
                );
                const answer = await this.socket.emitWithAck('update-metadata', { sid: this.sessionId, expectedVersion, metadata });
                if (answer.result === 'success') {
                    const decrypted = decryptSessionField<Metadata>(
                        { key: this.encryptionKey, variant: this.encryptionVariant },
                        this.sessionId,
                        'metadata',
                        answer.version,
                        answer.metadata,
                    );
                    if (!decrypted.success) {
                        throw new Error('Metadata response failed authenticated binding');
                    }
                    this.metadata = decrypted.value;
                    this.metadataVersion = answer.version;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        const decrypted = decryptSessionField<Metadata>(
                            { key: this.encryptionKey, variant: this.encryptionVariant },
                            this.sessionId,
                            'metadata',
                            answer.version,
                            answer.metadata,
                        );
                        if (!decrypted.success) {
                            throw new Error('Metadata conflict failed authenticated binding');
                        }
                        this.metadataVersion = answer.version;
                        this.metadata = decrypted.value;
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debug('Updating agent state', agentStateLogMetadata(this.agentState));
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const expectedVersion = this.agentStateVersion;
                const agentState = encryptSessionField(
                    { key: this.encryptionKey, variant: this.encryptionVariant },
                    this.sessionId,
                    'agentState',
                    expectedVersion + 1,
                    updated,
                );
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion, agentState });
                if (answer.result === 'success') {
                    const decrypted = decryptSessionField<AgentState>(
                        { key: this.encryptionKey, variant: this.encryptionVariant },
                        this.sessionId,
                        'agentState',
                        answer.version,
                        answer.agentState,
                    );
                    if (!decrypted.success) {
                        throw new Error('Agent state response failed authenticated binding');
                    }
                    this.agentState = decrypted.value;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', agentStateLogMetadata(this.agentState));
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        const decrypted = decryptSessionField<AgentState>(
                            { key: this.encryptionKey, variant: this.encryptionVariant },
                            this.sessionId,
                            'agentState',
                            answer.version,
                            answer.agentState,
                        );
                        if (!decrypted.success) {
                            throw new Error('Agent state conflict failed authenticated binding');
                        }
                        this.agentStateVersion = answer.version;
                        this.agentState = decrypted.value;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await Promise.race([
            this.sendSync.invalidateAndAwait(),
            delay(10000)
        ]);
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.sendSync.stop();
        this.receiveSync.stop();
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.socket.close();
    }

    private startSmartReconnect() {
        if (this.reconnectInterval) return;

        this.reconnectInterval = setInterval(() => {
            if (this.socket.connected) {
                clearInterval(this.reconnectInterval!);
                this.reconnectInterval = null;
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API] Still not ready to reconnect');
                return;
            }
            logger.debug('[API] Attempting reconnect');
            this.socket.connect();
        }, 3000);

        if (shouldReconnect()) {
            logger.debug('[API] Network up + lid open — reconnecting in 1s');
            setTimeout(() => { if (!this.socket.connected) this.socket.connect() }, 1000);
        }
    }
}
