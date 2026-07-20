/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration, encryption/decryption, and handler execution
 */

import { logger as defaultLogger } from '@/ui/logger';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '@/api/encryption';
import {
    RpcHandler,
    RpcHandlerMap,
    RpcRequest,
    RpcHandlerConfig,
} from './types';
import { Socket } from 'socket.io-client';
import { join } from 'node:path';
import {
    AuthenticatedRpcRequestSchema,
    createAuthenticatedRpcError,
    createAuthenticatedRpcSuccess,
    type AuthenticatedRpcErrorCode,
    type AuthenticatedRpcRequest,
    RPC_REQUEST_MAX_AGE_MS,
    RPC_REQUEST_MAX_FUTURE_SKEW_MS,
} from '@northglass/idle-wire';
import { configuration } from '@/configuration';
import { DurableRpcReplayStore } from './DurableRpcReplayStore';

const MAX_RPC_CIPHERTEXT_CHARS = 16 * 1024 * 1024;
const MAX_RPC_RESULT_PLAINTEXT_BYTES = 16 * 1024 * 1024;

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map();
    private readonly scopePrefix: string;
    private readonly encryptionKey: Uint8Array;
    private readonly encryptionVariant: 'legacy' | 'dataKey';
    private readonly logger: (message: string, data?: any) => void;
    private socket: Socket | null = null;
    private readonly replayStore: DurableRpcReplayStore;
    private readonly now: () => number;

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix;
        this.encryptionKey = config.encryptionKey;
        this.encryptionVariant = config.encryptionVariant;
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, {
            hasMetadata: data !== undefined,
        }));
        this.replayStore = new DurableRpcReplayStore({
            directory: config.replayStoreDirectory ?? join(configuration.idleHomeDir, 'rpc-replay-v1'),
            maxEntries: config.replayStoreMaxEntries,
        });
        this.now = config.now ?? Date.now;
    }

    /**
     * Register an RPC handler for a specific method
     * @param method - The method name (without prefix)
     * @param handler - The handler function
     */
    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method);

        // Store the handler
        this.handlers.set(prefixedMethod, handler);

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    unregisterHandler(method: string): void {
        const prefixedMethod = this.getPrefixedMethod(method);
        this.handlers.delete(prefixedMethod);

        if (this.socket) {
            this.socket.emit('rpc-unregister', { method: prefixedMethod });
        }
    }

    /**
     * Handle an incoming RPC request
     * @param request - The RPC request data
     * @param callback - The response callback
     */
    async handleRequest(
        request: RpcRequest,
    ): Promise<any> {
        let authenticatedRequest: AuthenticatedRpcRequest | null = null;
        try {
            if (
                !request
                || typeof request.method !== 'string'
                || typeof request.params !== 'string'
                || request.params.length < 1
                || request.params.length > MAX_RPC_CIPHERTEXT_CHARS
            ) {
                throw new Error('Invalid RPC request');
            }
            // Decrypt the incoming params
            const ciphertext = decodeBase64(request.params);
            const decryptedParams = decrypt(this.encryptionKey, this.encryptionVariant, ciphertext);
            if (decryptedParams === null) {
                throw new Error('Invalid RPC payload');
            }

            authenticatedRequest = this.consumeAuthenticatedRequest(
                request.method,
                decryptedParams,
            );

            // Resolve the handler only after the fresh authenticated identity
            // has been consumed. Otherwise a relay can alter the visible route,
            // induce a retry with an encrypted failure, and later replay the
            // original route without having spent the first request identity.
            const handler = this.handlers.get(request.method);
            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found');
                return this.encryptErrorResponse(
                    authenticatedRequest,
                    'METHOD_NOT_FOUND',
                    'Method not found',
                );
            }

            // Call the handler
            this.logger('[RPC] Calling handler');
            const result = await handler(authenticatedRequest.params);
            this.logger('[RPC] Handler returned', { hasResult: result !== undefined });

            const responsePayload = authenticatedRequest.v === 2
                ? createAuthenticatedRpcSuccess(authenticatedRequest, result)
                : result;
            const serializedResult = JSON.stringify(responsePayload) ?? 'null';
            if (Buffer.byteLength(serializedResult, 'utf8') > MAX_RPC_RESULT_PLAINTEXT_BYTES) {
                return this.encryptErrorResponse(
                    authenticatedRequest,
                    'RESULT_TOO_LARGE',
                    'RPC response too large',
                );
            }

            // Encrypt and return the response
            const encryptedResponse = encodeBase64(encrypt(
                this.encryptionKey,
                this.encryptionVariant,
                responsePayload,
            ));
            this.logger('[RPC] Sending encrypted response', {
                responseLength: encryptedResponse.length,
            });
            return encryptedResponse;
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request');
            if (authenticatedRequest) {
                return this.encryptErrorResponse(
                    authenticatedRequest,
                    'HANDLER_FAILED',
                    error instanceof Error ? error.message : 'Unknown error',
                );
            }
            const errorResponse = {
                error: error instanceof Error ? error.message : 'Unknown error'
            };
            return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, errorResponse));
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket;
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod });
        }
    }

    onSocketDisconnect(): void {
        this.socket = null;
    }

    /**
     * Get the number of registered handlers
     */
    getHandlerCount(): number {
        return this.handlers.size;
    }

    /**
     * Check if a handler is registered
     * @param method - The method name (without prefix)
     */
    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method);
        return this.handlers.has(prefixedMethod);
    }

    /**
     * Clear all handlers
     */
    clearHandlers(): void {
        this.handlers.clear();
        this.logger('Cleared all RPC handlers');
    }

    /**
     * Get the prefixed method name
     * @param method - The method name
     */
    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`;
    }

    private consumeAuthenticatedRequest(
        outerMethod: string,
        decryptedParams: unknown,
    ): AuthenticatedRpcRequest {
        const parsed = AuthenticatedRpcRequestSchema.safeParse(decryptedParams);
        if (!parsed.success) {
            throw new Error('Invalid authenticated RPC request');
        }

        const request = parsed.data;
        const now = this.now();
        if (
            request.issuedAt < now - RPC_REQUEST_MAX_AGE_MS
            || request.issuedAt > now + RPC_REQUEST_MAX_FUTURE_SKEW_MS
        ) {
            throw new Error('RPC request expired');
        }

        try {
            const consumption = this.replayStore.consume(request.scope, request.requestId, now);
            if (consumption === 'replay') {
                throw new Error('RPC request replayed');
            }
            if (consumption === 'saturated') {
                throw new Error('RPC replay protection unavailable');
            }
        } catch (error) {
            if (
                error instanceof Error
                && (error.message === 'RPC request replayed'
                    || error.message === 'RPC replay protection unavailable')
            ) {
                throw error;
            }
            throw new Error('RPC replay protection unavailable');
        }

        // Consume first so a relay-modified visible route cannot manufacture a
        // retryable encrypted error and preserve the original identity for a
        // second delivery. A malicious relay can already drop requests; this
        // ordering prevents it from upgrading availability interference into
        // duplicate side effects.
        if (
            request.scope !== this.scopePrefix
            || outerMethod !== this.getPrefixedMethod(request.method)
        ) {
            throw new Error('Invalid authenticated RPC request');
        }

        return request;
    }

    private encryptErrorResponse(
        request: AuthenticatedRpcRequest,
        code: AuthenticatedRpcErrorCode,
        legacyMessage: string,
    ): string {
        const payload = request.v === 2
            ? createAuthenticatedRpcError(request, code)
            : { error: legacyMessage };
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, payload));
    }
}

/**
 * Factory function to create an RPC handler manager
 */
export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config);
}
