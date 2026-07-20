import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { RawRecord } from '../typesRaw';
import { ApiMessage } from '../apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema, AgentState, AgentStateSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';
import { retainAgentStateWithinBudget } from '../agentStateRetention';
import {
    AuthenticatedRpcResponseSchema,
    createAuthenticatedSessionFieldEnvelope,
    createAuthenticatedRpcRequest,
    createAuthenticatedMessageIdentity,
    isAuthenticatedSessionFieldEnvelopeCandidate,
    isBoundedEncryptedMessageCiphertext,
    readAuthenticatedSessionFieldEnvelope,
    type AuthenticatedRpcRequestIdentity,
} from '@northglass/idle-wire';
import {
    CryptoDigestAlgorithm,
    digestStringAsync,
    randomUUID,
} from 'expo-crypto';

type SessionFieldBinding = 'bound' | 'legacy';

export type MetadataDecryptionResult =
    | { success: true; value: Metadata; binding: SessionFieldBinding }
    | { success: false };

export type AgentStateDecryptionResult =
    | { success: true; value: AgentState; binding: SessionFieldBinding }
    | { success: false };

type SessionFieldDecryptionOptions = {
    /** Initial sync may display old raw values while current live updates fail closed. */
    allowLegacy?: boolean;
};

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    private ciphertextCommitment(ciphertext: string): Promise<string> {
        return digestStringAsync(CryptoDigestAlgorithm.SHA256, ciphertext);
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: ApiMessage[]): Promise<(DecryptedMessage | null)[]> {
        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: ApiMessage }[] = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message) {
                results[i] = null;
                continue;
            }

            // Check cache first
            const cached = this.cache.getCachedMessage(this.sessionId, message.id);
            if (cached) {
                results[i] = cached;
            } else if (message.content.t === 'encrypted') {
                toDecrypt.push({ index: i, message });
            } else {
                // Not encrypted or invalid
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: null,
                    createdAt: message.createdAt,
                };
                this.cache.setCachedMessage(this.sessionId, message.id, results[i]!);
            }
        }

        // Batch decrypt uncached messages
        if (toDecrypt.length > 0) {
            const decryptable: { index: number; message: ApiMessage; encrypted: Uint8Array }[] = [];
            for (const item of toDecrypt) {
                if (!isBoundedEncryptedMessageCiphertext(item.message.content.c)) {
                    const result: DecryptedMessage = {
                        id: item.message.id,
                        seq: item.message.seq,
                        localId: item.message.localId ?? null,
                        content: null,
                        createdAt: item.message.createdAt,
                    };
                    this.cache.setCachedMessage(this.sessionId, item.message.id, result);
                    results[item.index] = result;
                    continue;
                }
                try {
                    decryptable.push({
                        ...item,
                        encrypted: decodeBase64(item.message.content.c, 'base64'),
                    });
                } catch {
                    const result: DecryptedMessage = {
                        id: item.message.id,
                        seq: item.message.seq,
                        localId: item.message.localId ?? null,
                        content: null,
                        createdAt: item.message.createdAt,
                    };
                    this.cache.setCachedMessage(this.sessionId, item.message.id, result);
                    results[item.index] = result;
                }
            }

            if (decryptable.length > 0) {
                const decrypted = await this.encryptor.decrypt(decryptable.map((item) => item.encrypted));
                for (let i = 0; i < decryptable.length; i++) {
                    const decryptedData = decrypted[i];
                    const { message, index } = decryptable[i];

                    if (decryptedData) {
                        const result: DecryptedMessage = {
                            id: message.id,
                            seq: message.seq,
                            localId: message.localId ?? null,
                            content: decryptedData,
                            createdAt: message.createdAt,
                        };
                        this.cache.setCachedMessage(this.sessionId, message.id, result);
                        results[index] = result;
                    } else {
                        const result: DecryptedMessage = {
                            id: message.id,
                            seq: message.seq,
                            localId: message.localId ?? null,
                            content: null,
                            createdAt: message.createdAt,
                        };
                        this.cache.setCachedMessage(this.sessionId, message.id, result);
                        results[index] = result;
                    }
                }
            }
        }

        return results;
    }

    /**
     * Single message convenience method
     */
    async decryptMessage(message: ApiMessage | null | undefined): Promise<DecryptedMessage | null> {
        if (!message) {
            return null;
        }
        const results = await this.decryptMessages([message]);
        return results[0];
    }

    /**
     * Encrypt a raw record
     */
    async encryptRawRecord(record: RawRecord, messageId: string): Promise<string> {
        const encrypted = await this.encryptor.encrypt([{
            ...record,
            messageIdentity: createAuthenticatedMessageIdentity(this.sessionId, messageId),
        }]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Encrypt raw data using session-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /** Encrypt params with authenticated RPC identity, scope, and freshness. */
    async encryptRpcRequest(
        method: string,
        params: unknown,
    ): Promise<{
        ciphertext: string;
        expected: AuthenticatedRpcRequestIdentity;
    }> {
        const request = createAuthenticatedRpcRequest(
            this.sessionId,
            method,
            params,
            randomUUID(),
            Date.now(),
        );
        const encrypted = await this.encryptor.encrypt([request]);
        return {
            ciphertext: encodeBase64(encrypted[0], 'base64'),
            expected: {
                scope: request.scope,
                method: request.method,
                requestId: request.requestId,
            },
        };
    }

    /** Decrypt and correlate a response to the exact outbound RPC request. */
    async decryptRpcResponse(
        encrypted: string,
        expected: AuthenticatedRpcRequestIdentity,
    ): Promise<unknown> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            const parsed = AuthenticatedRpcResponseSchema.safeParse(decrypted[0]);
            if (
                !parsed.success
                || parsed.data.scope !== expected.scope
                || parsed.data.method !== expected.method
                || parsed.data.requestId !== expected.requestId
            ) {
                throw new Error('Invalid RPC response');
            }
            if (!parsed.data.ok) {
                throw new Error('Remote control request was rejected');
            }
            return parsed.data.result;
        } catch (error) {
            if (
                error instanceof Error
                && error.message === 'Remote control request was rejected'
            ) {
                throw error;
            }
            throw new Error('Invalid RPC response');
        }
    }

    /**
     * Decrypt raw data using session-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Encrypt metadata using session-specific encryption
     */
    async encryptMetadata(version: number, metadata: Metadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                this.sessionId,
                'metadata',
                version,
                metadata,
            ),
        ]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Strictly decrypt metadata using session-specific encryption. Current
     * live updates must carry an authenticated session/field/version binding.
     */
    async decryptMetadataResult(
        version: number,
        encrypted: string,
        options: SessionFieldDecryptionOptions = {},
    ): Promise<MetadataDecryptionResult> {
        try {
            const ciphertextCommitment = await this.ciphertextCommitment(encrypted);
            const cached = this.cache.getCachedMetadata(
                this.sessionId,
                version,
                ciphertextCommitment,
            );
            if (cached.status === 'conflict') {
                return { success: false };
            }
            if (cached.status === 'hit') {
                return { success: true, value: cached.data, binding: 'bound' };
            }

            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            if (!decrypted[0]) {
                return { success: false };
            }

            const bound = readAuthenticatedSessionFieldEnvelope(decrypted[0], {
                sessionId: this.sessionId,
                field: 'metadata',
                version,
            });
            const binding: SessionFieldBinding = bound.success ? 'bound' : 'legacy';
            if (
                !bound.success
                && (
                    !options.allowLegacy
                    || isAuthenticatedSessionFieldEnvelopeCandidate(decrypted[0])
                )
            ) {
                return { success: false };
            }

            const parsed = MetadataSchema.safeParse(
                bound.success ? bound.value : decrypted[0],
            );
            if (!parsed.success) {
                return { success: false };
            }

            // Never cache a legacy value as if it had passed the cryptographic
            // coordinate check. Live updates use this cache and fail closed.
            if (binding === 'bound') {
                const accepted = this.cache.setCachedMetadata(
                    this.sessionId,
                    version,
                    ciphertextCommitment,
                    parsed.data,
                );
                if (accepted === false) {
                    return { success: false };
                }
            }
            return { success: true, value: parsed.data, binding };
        } catch {
            return { success: false };
        }
    }

    /** Read current bound metadata and legacy metadata during initial sync. */
    async decryptMetadata(version: number, encrypted: string): Promise<Metadata | null> {
        const result = await this.decryptMetadataResult(version, encrypted, {
            allowLegacy: true,
        });
        return result.success ? result.value : null;
    }

    /**
     * Encrypt agent state using session-specific encryption
     */
    async encryptAgentState(version: number, state: AgentState): Promise<string> {
        const encrypted = await this.encryptor.encrypt([
            createAuthenticatedSessionFieldEnvelope(
                this.sessionId,
                'agentState',
                version,
                state,
            ),
        ]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt agent state using session-specific encryption
     */
    async decryptAgentStateResult(
        version: number,
        encrypted: string | null | undefined,
        options: SessionFieldDecryptionOptions = {},
    ): Promise<AgentStateDecryptionResult> {
        if (!encrypted) {
            return options.allowLegacy
                ? { success: true, value: {}, binding: 'legacy' }
                : { success: false };
        }

        try {
            const ciphertextCommitment = await this.ciphertextCommitment(encrypted);
            const cached = this.cache.getCachedAgentState(
                this.sessionId,
                version,
                ciphertextCommitment,
            );
            if (cached.status === 'conflict') {
                return { success: false };
            }
            if (cached.status === 'hit') {
                return {
                    success: true,
                    value: retainAgentStateWithinBudget(cached.data) ?? {},
                    binding: 'bound',
                };
            }

            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            if (!decrypted[0]) {
                return { success: false };
            }

            const bound = readAuthenticatedSessionFieldEnvelope(decrypted[0], {
                sessionId: this.sessionId,
                field: 'agentState',
                version,
            });
            const binding: SessionFieldBinding = bound.success ? 'bound' : 'legacy';
            if (
                !bound.success
                && (
                    !options.allowLegacy
                    || isAuthenticatedSessionFieldEnvelopeCandidate(decrypted[0])
                )
            ) {
                return { success: false };
            }

            const parsed = AgentStateSchema.safeParse(
                bound.success ? bound.value : decrypted[0],
            );
            if (!parsed.success) {
                return { success: false };
            }

            const retained = retainAgentStateWithinBudget(parsed.data) ?? {};
            if (binding === 'bound') {
                const accepted = this.cache.setCachedAgentState(
                    this.sessionId,
                    version,
                    ciphertextCommitment,
                    retained,
                );
                if (accepted === false) {
                    return { success: false };
                }
            }
            return { success: true, value: retained, binding };
        } catch {
            return { success: false };
        }
    }

    async decryptAgentState(version: number, encrypted: string | null | undefined): Promise<AgentState> {
        const result = await this.decryptAgentStateResult(version, encrypted, {
            allowLegacy: true,
        });
        return result.success ? result.value : {};
    }
}
