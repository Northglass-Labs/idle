import axios, { AxiosError } from 'axios';
import {
    AuthenticatedMessageIdentitySchema,
    CreateSessionResponseSchema,
    SessionMessageSchema,
    SessionRecordSchema,
    type SessionMessage as WireSessionMessage,
    type SessionRecord,
} from '@northglass/idle-wire';
import type { Config } from './config';
import type { Credentials } from './credentials';
import {
    decodeBase64,
    encodeBase64,
    decryptBoxBundle,
    decryptWithDataKey,
    decryptLegacy,
    libsodiumEncryptForPublicKey,
    getRandomBytes,
} from './encryption';
import { BEARER_HTTP_CONFIG, SESSION_CREATE_HTTP_CONFIG } from './httpSecurity';
import { createHash, randomUUID } from 'node:crypto';
import { decryptSessionField, encryptSessionField } from './sessionFieldEncryption';

// --- Types ---

export type EncryptionVariant = 'legacy' | 'dataKey';

export type RecordEncryption = {
    key: Uint8Array;
    variant: EncryptionVariant;
};

export type SessionEncryption = RecordEncryption;

export type RawSession = SessionRecord;

export type DecryptedSession = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: unknown;
    metadataVersion: number;
    agentState: unknown | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    encryption: RecordEncryption;
};

export type RawMachine = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: string | null;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
};

export type DecryptedMachine = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: unknown | null;
    metadataVersion: number;
    daemonState: unknown | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    encryption: RecordEncryption;
};

export type RawMessage = WireSessionMessage;

export type DecryptedMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

const MAX_SESSION_LIST_RECORDS = 500;
const MAX_MACHINE_LIST_RECORDS = 100;
const MAX_MESSAGE_LIST_RECORDS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSessionListResponse(value: unknown): RawSession[] {
    if (!isRecord(value) || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSION_LIST_RECORDS) {
        throw new Error('Relay returned an invalid session list');
    }
    const sessions: RawSession[] = [];
    for (const candidate of value.sessions) {
        const parsed = SessionRecordSchema.safeParse(candidate);
        if (!parsed.success) {
            throw new Error('Relay returned an invalid session list');
        }
        sessions.push(parsed.data);
    }
    return sessions;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNullableString(value: unknown, maxCharacters: number): value is string | null {
    return value === null || (
        typeof value === 'string'
        && value.length > 0
        && value.length <= maxCharacters
    );
}

function parseMachineListResponse(value: unknown): RawMachine[] {
    if (!Array.isArray(value) || value.length > MAX_MACHINE_LIST_RECORDS) {
        throw new Error('Relay returned an invalid machine list');
    }
    const machines: RawMachine[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate)
            || typeof candidate.id !== 'string'
            || candidate.id.length < 1
            || candidate.id.length > 64
            || !isSafeNonnegativeInteger(candidate.seq)
            || !isSafeNonnegativeInteger(candidate.createdAt)
            || !isSafeNonnegativeInteger(candidate.updatedAt)
            || typeof candidate.active !== 'boolean'
            || !isSafeNonnegativeInteger(candidate.activeAt)
            || !isBoundedNullableString(candidate.metadata, 16 * 1024)
            || !isSafeNonnegativeInteger(candidate.metadataVersion)
            || !isBoundedNullableString(candidate.daemonState, 64 * 1024)
            || !isSafeNonnegativeInteger(candidate.daemonStateVersion)
            || !isBoundedNullableString(candidate.dataEncryptionKey, 1024)
        ) {
            throw new Error('Relay returned an invalid machine list');
        }
        machines.push({
            id: candidate.id,
            seq: candidate.seq,
            createdAt: candidate.createdAt,
            updatedAt: candidate.updatedAt,
            active: candidate.active,
            activeAt: candidate.activeAt,
            metadata: candidate.metadata,
            metadataVersion: candidate.metadataVersion,
            daemonState: candidate.daemonState,
            daemonStateVersion: candidate.daemonStateVersion,
            dataEncryptionKey: candidate.dataEncryptionKey,
        });
    }
    return machines;
}

function parseMessageListResponse(value: unknown): RawMessage[] {
    if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGE_LIST_RECORDS) {
        throw new Error('Relay returned an invalid message list');
    }
    const messages: RawMessage[] = [];
    for (const candidate of value.messages) {
        const parsed = SessionMessageSchema.safeParse(candidate);
        if (!parsed.success) {
            throw new Error('Relay returned an invalid message list');
        }
        messages.push(parsed.data);
    }
    return messages;
}

// --- Session encryption key resolution ---

function resolveRecordEncryption(
    record: { id: string; dataEncryptionKey: string | null },
    creds: Credentials,
    recordLabel: string,
): RecordEncryption {
    if (record.dataEncryptionKey) {
        const encrypted = decodeBase64(record.dataEncryptionKey);
        if (encodeBase64(encrypted) !== record.dataEncryptionKey || encrypted.length < 2) {
            throw new Error(`Invalid ${recordLabel} key encoding for ${recordLabel} ${record.id}`);
        }
        if (encrypted[0] !== 0) {
            throw new Error(`Unsupported ${recordLabel} key version for ${recordLabel} ${record.id}`);
        }
        const bundle = encrypted.slice(1);
        const sessionKey = decryptBoxBundle(bundle, creds.contentKeyPair.secretKey);
        if (!sessionKey || sessionKey.length !== 32) {
            throw new Error(`Failed to decrypt ${recordLabel} key for ${recordLabel} ${record.id}`);
        }
        return { key: sessionKey, variant: 'dataKey' };
    }
    // Legacy: use account secret directly
    return { key: creds.secret, variant: 'legacy' };
}

export function resolveSessionEncryption(
    session: RawSession,
    creds: Credentials,
): SessionEncryption {
    return resolveRecordEncryption(session, creds, 'session');
}

export function resolveMachineEncryption(
    machine: RawMachine,
    creds: Credentials,
): RecordEncryption {
    return resolveRecordEncryption(machine, creds, 'machine');
}

// --- Decrypt helpers ---

function decryptField(
    encrypted: string | null,
    encryption: RecordEncryption,
): unknown | null {
    if (!encrypted) return null;
    const data = decodeBase64(encrypted);
    if (encryption.variant === 'dataKey') {
        return decryptWithDataKey(data, encryption.key);
    }
    return decryptLegacy(data, encryption.key);
}

function authenticateHistoryMessage(
    message: RawMessage,
    sessionId: string,
    encryption: SessionEncryption,
    seenReplayKeys: Set<string>,
): DecryptedMessage | null {
    const ciphertext = decodeBase64(message.content.c);
    const content = encryption.variant === 'dataKey'
        ? decryptWithDataKey(ciphertext, encryption.key)
        : decryptLegacy(ciphertext, encryption.key);
    if (content === null) return null;

    let replayKey: string;
    if (isRecord(content) && Object.hasOwn(content, 'messageIdentity')) {
        const identity = AuthenticatedMessageIdentitySchema.safeParse(content.messageIdentity);
        if (
            !identity.success
            || identity.data.sessionId !== sessionId
            || identity.data.messageId !== message.localId
        ) {
            return null;
        }
        replayKey = `authenticated:${identity.data.messageId}`;
    } else {
        replayKey = `legacy-ciphertext:${createHash('sha256').update(ciphertext).digest('base64url')}`;
    }

    if (seenReplayKeys.has(replayKey)) return null;
    seenReplayKeys.add(replayKey);
    return {
        id: message.id,
        seq: message.seq,
        content,
        localId: message.localId ?? null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
    };
}

function decryptSession(raw: RawSession, creds: Credentials): DecryptedSession {
    const encryption = resolveSessionEncryption(raw, creds);
    const metadata = decryptSessionField(
        encryption,
        raw.id,
        'metadata',
        raw.metadataVersion,
        raw.metadata,
        { allowLegacy: true },
    );
    const agentState = raw.agentState
        ? decryptSessionField(
            encryption,
            raw.id,
            'agentState',
            raw.agentStateVersion,
            raw.agentState,
            { allowLegacy: true },
        )
        : null;
    if (!metadata.success || (agentState && !agentState.success)) {
        throw new Error(`Session ${raw.id} fields failed authenticated decryption`);
    }
    return {
        id: raw.id,
        seq: raw.seq,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        active: raw.active,
        activeAt: raw.activeAt,
        metadata: metadata.value,
        metadataVersion: raw.metadataVersion,
        agentState: agentState?.success ? agentState.value : null,
        agentStateVersion: raw.agentStateVersion,
        dataEncryptionKey: raw.dataEncryptionKey,
        encryption,
    };
}

function decryptMachine(raw: RawMachine, creds: Credentials): DecryptedMachine {
    const encryption = resolveMachineEncryption(raw, creds);
    return {
        id: raw.id,
        seq: raw.seq,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        active: raw.active,
        activeAt: raw.activeAt,
        metadata: decryptField(raw.metadata, encryption),
        metadataVersion: raw.metadataVersion,
        daemonState: decryptField(raw.daemonState, encryption),
        daemonStateVersion: raw.daemonStateVersion,
        dataEncryptionKey: raw.dataEncryptionKey,
        encryption,
    };
}

// --- Error handling ---

function handleApiError(err: unknown, context: string): never {
    if (err instanceof AxiosError) {
        const status = err.response?.status;
        if (status === 401) {
            throw new Error('Authentication expired. Run `idle-agent auth login` to re-authenticate.');
        }
        if (status === 403) {
            throw new Error(`Forbidden: ${context}. Check your account permissions.`);
        }
        if (status === 404) {
            throw new Error(`Not found: ${context}`);
        }
        if (status && status >= 400 && status < 500) {
            // Relay error bodies are untrusted and may contain reflected
            // request data, provider details, or credentials. Keep terminal
            // failures useful without copying that body across the local
            // diagnostic boundary.
            throw new Error(`Request failed (${status}): ${context}`);
        }
        if (status && status >= 500) {
            throw new Error(`Server error (${status}): ${context}`);
        }
        throw new Error(`Request failed: ${err.message}`);
    }
    throw err;
}

function authHeaders(creds: Credentials): Record<string, string> {
    return {
        Authorization: `Bearer ${creds.token}`,
        'X-Happy-Client': 'cli-control-plane/0.1.0',
    };
}

// --- API functions ---

export async function listSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    let data: { sessions: RawSession[] };
    try {
        const resp = await axios.get(`${config.serverUrl}/v1/sessions`, {
            headers: authHeaders(creds),
            ...BEARER_HTTP_CONFIG,
        });
        data = { sessions: parseSessionListResponse(resp.data) };
    } catch (err) {
        handleApiError(err, 'listing sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function listMachines(
    config: Config,
    creds: Credentials,
): Promise<DecryptedMachine[]> {
    let data: RawMachine[];
    try {
        const resp = await axios.get(`${config.serverUrl}/v1/machines`, {
            headers: authHeaders(creds),
            ...BEARER_HTTP_CONFIG,
        });
        data = parseMachineListResponse(resp.data);
    } catch (err) {
        handleApiError(err, 'listing machines');
    }

    return data.map(raw => decryptMachine(raw, creds));
}

export async function listActiveSessions(
    config: Config,
    creds: Credentials,
): Promise<DecryptedSession[]> {
    let data: { sessions: RawSession[] };
    try {
        const resp = await axios.get(`${config.serverUrl}/v2/sessions/active`, {
            headers: authHeaders(creds),
            ...BEARER_HTTP_CONFIG,
        });
        data = { sessions: parseSessionListResponse(resp.data) };
    } catch (err) {
        handleApiError(err, 'listing active sessions');
    }

    return data.sessions.map(raw => decryptSession(raw, creds));
}

export async function createSession(
    config: Config,
    creds: Credentials,
    opts: { tag: string; metadata: unknown },
): Promise<DecryptedSession & { sessionKey: Uint8Array }> {
    // Generate random 32-byte per-session AES key
    const sessionKey = getRandomBytes(32);

    // Encrypt session key with content public key, prepend version byte
    const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, creds.contentKeyPair.publicKey);
    const withVersion = new Uint8Array(1 + encryptedKey.length);
    withVersion[0] = 0x00; // version byte
    withVersion.set(encryptedKey, 1);
    const dataEncryptionKeyBase64 = encodeBase64(withVersion);

    // Choose the ID before encryption so the first stored value is bound to
    // the same session coordinate exposed by the relay.
    const requestedSessionId = randomUUID();
    if (opts.metadata === null || typeof opts.metadata !== 'object' || Array.isArray(opts.metadata)) {
        throw new Error('Session metadata must be an object');
    }
    const metadataBase64 = encryptSessionField(
        { key: sessionKey, variant: 'dataKey' },
        requestedSessionId,
        'metadata',
        0,
        opts.metadata as Record<string, unknown>,
    );

    let data: { session: RawSession };
    try {
        const resp = await axios.post(
            `${config.serverUrl}/v2/sessions`,
            {
                id: requestedSessionId,
                tag: opts.tag,
                metadata: metadataBase64,
                dataEncryptionKey: dataEncryptionKeyBase64,
            },
            { headers: authHeaders(creds), ...SESSION_CREATE_HTTP_CONFIG },
        );
        const parsed = CreateSessionResponseSchema.safeParse(resp.data);
        if (!parsed.success) {
            throw new Error('Relay returned an invalid session response');
        }
        data = parsed.data;
    } catch (err) {
        if (err instanceof AxiosError && err.response?.status === 404) {
            throw new Error(
                'This relay does not support bound session creation. Upgrade the relay and retry.',
            );
        }
        handleApiError(err, 'creating session');
    }

    try {
        const decrypted = decryptSession(data.session, creds);
        return { ...decrypted, sessionKey: decrypted.encryption.key };
    } catch (error) {
        if (data.session.id !== requestedSessionId) {
            throw new Error(
                'The relay returned a different session ID with unreadable bound fields. '
                + 'Current clients require a relay that preserves client-selected IDs for new sessions. '
                + 'Upgrade the relay and retry.',
            );
        }
        throw error;
    }
}

export async function deleteSession(
    config: Config,
    creds: Credentials,
    sessionId: string,
): Promise<void> {
    try {
        await axios.delete(`${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
            headers: authHeaders(creds),
            ...BEARER_HTTP_CONFIG,
        });
    } catch (err) {
        handleApiError(err, `deleting session ${sessionId}`);
    }
}

export async function getSessionMessages(
    config: Config,
    creds: Credentials,
    sessionId: string,
    encryption: SessionEncryption,
): Promise<DecryptedMessage[]> {
    let data: { messages: RawMessage[] };
    try {
        const resp = await axios.get(
            `${config.serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
            { headers: authHeaders(creds), ...BEARER_HTTP_CONFIG },
        );
        data = { messages: parseMessageListResponse(resp.data) };
    } catch (err) {
        handleApiError(err, `session ${sessionId} messages`);
    }

    const seenReplayKeys = new Set<string>();
    return data.messages.flatMap(message => {
        const authenticated = authenticateHistoryMessage(
            message,
            sessionId,
            encryption,
            seenReplayKeys,
        );
        return authenticated ? [authenticated] : [];
    });
}
