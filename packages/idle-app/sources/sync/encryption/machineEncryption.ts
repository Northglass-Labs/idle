import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { MachineMetadata, MachineMetadataSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';
import {
    AuthenticatedRpcResponseSchema,
    createAuthenticatedRpcRequest,
    type AuthenticatedRpcRequestIdentity,
} from '@northglass/idle-wire';
import { randomUUID } from 'expo-crypto';

export class MachineEncryption {
    private machineId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        machineId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.machineId = machineId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /**
     * Encrypt machine metadata
     */
    async encryptMetadata(metadata: MachineMetadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([metadata]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt machine metadata with caching
     */
    async decryptMetadata(version: number, encrypted: string): Promise<MachineMetadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMachineMetadata(this.machineId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            if (!decrypted[0]) {
                return null;
            }

            const parsed = MachineMetadataSchema.safeParse(decrypted[0]);
            if (!parsed.success) {
                console.error('Failed to parse machine metadata');
                return null;
            }

            // Cache the result
            this.cache.setCachedMachineMetadata(this.machineId, version, parsed.data);
            return parsed.data;
        } catch (error) {
            console.error('Failed to decrypt machine metadata');
            return null;
        }
    }

    /**
     * Encrypt daemon state
     */
    async encryptDaemonState(state: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([state]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt daemon state with caching
     */
    async decryptDaemonState(version: number, encrypted: string | null | undefined): Promise<any | null> {
        if (!encrypted) {
            return null;
        }

        // Check cache first
        const cached = this.cache.getCachedDaemonState(this.machineId, version);
        if (cached !== undefined) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            const result = decrypted[0] || null;

            // Cache the result (including null values)
            this.cache.setCachedDaemonState(this.machineId, version, result);
            return result;
        } catch (error) {
            console.error('Failed to decrypt daemon state');
            // Cache null result to avoid repeated decryption attempts
            this.cache.setCachedDaemonState(this.machineId, version, null);
            return null;
        }
    }

    /**
     * Encrypt raw data using machine-specific encryption
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
            this.machineId,
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
     * Decrypt raw data using machine-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            console.error('Failed to decrypt machine data');
            return null;
        }
    }
}
