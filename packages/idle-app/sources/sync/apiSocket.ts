import { io, Socket } from 'socket.io-client';
import { z } from 'zod';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { streamingFetch } from './streamingFetch';
import { getSafeConnectionErrorMessage } from './socketDiagnosticPrivacy';
import { buildAuthenticatedRequestUrl } from './authenticatedRequestUrl';

const MAX_RPC_ACK_CIPHERTEXT_CHARACTERS = 24 * 1024 * 1024;
const RpcAcknowledgementSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        result: z.string().min(1).max(MAX_RPC_ACK_CIPHERTEXT_CHARACTERS),
    }).strict(),
    z.object({
        ok: z.literal(false),
        error: z.string().min(1).max(512),
    }).strict(),
]);
export function getIdleClientId(): string {
    const platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}

/**
 * Compute the current "active" or "background" state for the current platform.
 * Mobile uses AppState. Web uses document.visibilityState + window focus —
 * "active" means the tab is visible AND has focus, so a backgrounded tab or an
 * unfocused window correctly counts as background and won't suppress mobile pushes.
 */
export function getCurrentAppState(): 'active' | 'background' {
    if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
            return 'active';
        }
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        return visible && focused ? 'active' : 'background';
    }
    return AppState.currentState === 'active' ? 'active' : 'background';
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export interface ApiSocketDetails {
    /** Error message string (NOT the raw Error object — that may carry sensitive socket internals). */
    lastErrorMessage: string | null;
    /** Number of reconnect attempts since the last successful connection. */
    reconnectAttempts: number;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

    // Diagnostic details are separate from `currentStatus` so consumers can
    // explain a failure without overloading the stable status enum.
    private detailsListeners: Set<(details: ApiSocketDetails) => void> = new Set();
    private currentDetails: ApiSocketDetails = { lastErrorMessage: null, reconnectAttempts: 0 };

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }

        this.updateStatus('connecting');

        this.socket = io(this.config.endpoint, {
            path: '/v1/updates',
            auth: {
                token: this.config.token,
                clientType: 'user-scoped' as const,
                happyClient: getIdleClientId(),
                appState: getCurrentAppState(),
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        this.setupEventHandlers();
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    onDetailsChange = (listener: (details: ApiSocketDetails) => void) => {
        this.detailsListeners.add(listener);
        // Immediately notify with current details so newly-attached listeners see latest state.
        listener(this.currentDetails);
        return () => this.detailsListeners.delete(listener);
    };

    private updateDetails(patch: Partial<ApiSocketDetails>) {
        const next: ApiSocketDetails = { ...this.currentDetails, ...patch };
        const changed =
            next.lastErrorMessage !== this.currentDetails.lastErrorMessage ||
            next.reconnectAttempts !== this.currentDetails.reconnectAttempts;
        if (changed) {
            this.currentDetails = next;
            this.detailsListeners.forEach((listener) => listener(next));
        }
    }

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A): Promise<R> {
        const sessionEncryption = this.encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw new Error('Session encryption is unavailable');
        }

        let acknowledgement: unknown;
        const request = await sessionEncryption.encryptRpcRequest(method, params);
        try {
            acknowledgement = await this.socket!.emitWithAck('rpc-call', {
                method: `${sessionId}:${method}`,
                params: request.ciphertext,
            });
        } catch {
            throw new Error('Remote control request failed');
        }
        const result = RpcAcknowledgementSchema.safeParse(acknowledgement);
        if (!result.success) throw new Error('Invalid RPC response');
        if (!result.data.ok) throw new Error('Remote control request failed');
        try {
            return await sessionEncryption.decryptRpcResponse(
                result.data.result,
                request.expected,
            ) as R;
        } catch (error) {
            if (error instanceof Error && error.message === 'Remote control request was rejected') {
                throw error;
            }
            throw new Error('Invalid RPC response');
        }
    }

    /** Send an authenticated encrypted machine-scoped control request. */
    async machineRPC<R, A>(machineId: string, method: string, params: A): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error('Machine encryption is unavailable');
        }

        let acknowledgement: unknown;
        const request = await machineEncryption.encryptRpcRequest(method, params);
        try {
            acknowledgement = await this.socket!.emitWithAck('rpc-call', {
                method: `${machineId}:${method}`,
                params: request.ciphertext,
            });
        } catch {
            throw new Error('Remote control request failed');
        }
        const result = RpcAcknowledgementSchema.safeParse(acknowledgement);
        if (!result.success) throw new Error('Invalid RPC response');
        if (!result.data.ok) throw new Error('Remote control request failed');
        try {
            return await machineEncryption.decryptRpcResponse(
                result.data.result,
                request.expected,
            ) as R;
        } catch (error) {
            if (error instanceof Error && error.message === 'Remote control request was rejected') {
                throw error;
            }
            throw new Error('Invalid RPC response');
        }
    }

    /**
     * Sends app focus state to server for push notification routing.
     * Server uses this to suppress pushes when the mobile app is in foreground.
     */
    sendAppState(state: string) {
        this.socket?.emit('app-state', { state });
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        try {
            return await this.socket.emitWithAck(event, data);
        } catch {
            throw new Error('Socket acknowledgement failed');
        }
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const url = buildAuthenticatedRequestUrl(this.config.endpoint, path);
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const headers = {
            ...options?.headers,
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getIdleClientId(),
        };

        return streamingFetch(url, {
            ...options,
            redirect: 'error',
            headers
        });
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            this.updateStatus('connected');
            // Clear diagnostic details on successful connect — the recovered state should not
            // continue to show stale "5 attempts / last error" in the detail sheet.
            this.updateDetails({ lastErrorMessage: null, reconnectAttempts: 0 });
            // Always fire reconnect listeners on connect, regardless of Socket.IO's
            // `recovered` flag. Transport recovery does not prove that the
            // application-layer subscription state survived; sessions can silently go
            // stale on stable wifi (no real disconnect, "recovered: true")
            // until the client sends a message. The extra REST roundtrip on every
            // connect is cheap; the silent-stale-session bug is bad.
            this.reconnectedListeners.forEach(listener => listener());
        });

        this.socket.on('disconnect', (reason) => {
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            this.updateStatus('error');
            this.updateDetails({ lastErrorMessage: getSafeConnectionErrorMessage(error) });
        });

        this.socket.on('error', (error) => {
            this.updateStatus('error');
            this.updateDetails({ lastErrorMessage: getSafeConnectionErrorMessage(error) });
        });

        // Socket.io fires `reconnect_attempt` with the current attempt number before each
        // retry. Surface the counter to the diagnostic sheet so users can see "5 attempts" /
        // "30 attempts" — useful signal for "is this a flaky network or a hard outage".
        this.socket.io.on('reconnect_attempt', (attempt: number) => {
            this.updateDetails({ reconnectAttempts: attempt });
        });

        // Message handling
        this.socket.onAny((event, data) => {
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
