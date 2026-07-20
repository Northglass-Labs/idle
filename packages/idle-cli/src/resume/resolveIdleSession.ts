import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import { z } from 'zod';

import { decodeBase64 } from '@/api/encryption';
import { decryptSessionField } from '@/api/sessionFieldEncryption';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import {
    getLocalIdleAgentCredentialPath,
    readLocalIdleAgentCredentials,
    type LocalIdleAgentCredentials,
} from './localIdleAgentAuth';

const ResumableMetadataSchema = z.object({
    path: z.string().min(1),
    flavor: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexThreadId: z.string().optional(),
}).passthrough();

const MAX_SESSION_LOOKUP_RESPONSE_BYTES = 8 * 1024 * 1024;
const RawSessionSchema = z.object({
    id: z.string().min(1).max(64),
    active: z.boolean(),
    metadata: z.string().min(1).max(16 * 1024).base64(),
    metadataVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    agentState: z.string().max(4 * 1024 * 1024).nullable(),
    agentStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dataEncryptionKey: z.string().min(1).max(1024).base64().nullable(),
}).passthrough();
const SessionLookupResponseSchema = z.object({
    sessions: z.array(RawSessionSchema).max(150),
});

type RawSession = {
    id: string;
    active: boolean;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    seq: number;
    dataEncryptionKey: string | null;
};

type RecordEncryption = {
    key: Uint8Array;
    variant: 'legacy' | 'dataKey';
};

export type ResumableIdleSession = {
    id: string;
    active: boolean;
    metadata: Metadata;
};

export type ReconnectableIdleSession = ResumableIdleSession & {
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
};

export function resolveSessionRecordByPrefix<T extends { id: string }>(records: T[], sessionId: string): T {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error('Idle session ID is required: idle resume <session-id>');
    }

    const matches = records.filter((record) => record.id.startsWith(trimmed));
    if (matches.length === 0) {
        throw new Error(`No Idle session found matching "${trimmed}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous Idle session "${trimmed}" matches ${matches.length} sessions. Be more specific.`);
    }
    return matches[0];
}

function decryptBoxBundle(bundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    if (bundle.length < 56) {
        return null;
    }

    const ephemeralPublicKey = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 56);
    const ciphertext = bundle.slice(56);
    const decrypted = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);

    return decrypted ? new Uint8Array(decrypted) : null;
}

function readAgentCredentials() {
    const credentialPath = getLocalIdleAgentCredentialPath();
    const credentials = readLocalIdleAgentCredentials();
    if (!credentials) {
        throw new Error(
            `Cannot resume historical Idle sessions without ${credentialPath}. Run \`idle-agent auth login\` in this environment first.`,
        );
    }
    return credentials;
}

function resolveSessionEncryption(session: RawSession, credentials: LocalIdleAgentCredentials): RecordEncryption {
    if (session.dataEncryptionKey) {
        const encrypted = decodeBase64(session.dataEncryptionKey);
        const sessionKey = decryptBoxBundle(encrypted.slice(1), credentials.contentKeyPair.secretKey);
        if (!sessionKey) {
            throw new Error(`Failed to decrypt data key for Idle session ${session.id}`);
        }
        return {
            key: sessionKey,
            variant: 'dataKey',
        };
    }

    return {
        key: credentials.secret,
        variant: 'legacy',
    };
}

function decryptSessionMetadata(session: RawSession, credentials: LocalIdleAgentCredentials): Metadata {
    const encryption = resolveSessionEncryption(session, credentials);
    const decrypted = decryptSessionField(
        encryption,
        session.id,
        'metadata',
        session.metadataVersion,
        session.metadata,
        { allowLegacy: true },
    );

    if (!decrypted.success) {
        throw new Error(`Failed to decrypt metadata for Idle session ${session.id}`);
    }

    try {
        return ResumableMetadataSchema.parse(decrypted.value) as Metadata;
    } catch {
        throw new Error(`Idle session ${session.id} is missing resumable metadata.`);
    }
}

async function fetchSessions(credentials: LocalIdleAgentCredentials): Promise<RawSession[]> {
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
            },
            timeout: 15_000,
            maxContentLength: MAX_SESSION_LOOKUP_RESPONSE_BYTES,
            maxBodyLength: MAX_SESSION_LOOKUP_RESPONSE_BYTES,
            maxRedirects: 0,
        });
        const parsed = SessionLookupResponseSchema.safeParse(response.data);
        if (!parsed.success) {
            throw new Error('Invalid session lookup response');
        }
        return parsed.data.sessions;
    } catch (error) {
        if (error instanceof AxiosError) {
            if (error.response?.status === 401) {
                throw new Error('Idle session lookup authentication expired. Run `idle-agent auth login` in this environment.');
            }
            throw new Error(`Failed to load Idle sessions: ${error.message}`);
        }
        throw error;
    }
}

export async function resolveIdleSession(sessionId: string): Promise<ResumableIdleSession> {
    const credentials = readAgentCredentials();
    const sessions = await fetchSessions(credentials);
    const matched = resolveSessionRecordByPrefix(sessions, sessionId);
    return {
        id: matched.id,
        active: matched.active,
        metadata: decryptSessionMetadata(matched, credentials),
    };
}

export async function resolveReconnectableSession(sessionId: string): Promise<ReconnectableIdleSession> {
    const credentials = readAgentCredentials();
    const sessions = await fetchSessions(credentials);
    const matched = resolveSessionRecordByPrefix(sessions, sessionId);
    const encryption = resolveSessionEncryption(matched, credentials);
    return {
        id: matched.id,
        active: matched.active,
        metadata: decryptSessionMetadata(matched, credentials),
        seq: matched.seq,
        metadataVersion: matched.metadataVersion,
        agentStateVersion: matched.agentStateVersion,
        encryptionKey: encryption.key,
        encryptionVariant: encryption.variant,
    };
}
