import { AgentState, Metadata, MachineMetadata } from '../storageTypes';
import { DecryptedMessage } from '../storageTypes';

interface CacheEntry<T> {
    data: T;
    accessTime: number;
}

interface CiphertextBoundCacheEntry<T> extends CacheEntry<T> {
    ciphertextCommitment: string;
}

export type CiphertextBoundCacheLookup<T> =
    | { status: 'miss' }
    | { status: 'conflict' }
    | { status: 'hit'; data: T };

function messageCacheSessionPrefix(sessionId: string): string {
    return `${sessionId.length}:${sessionId}:`;
}

function messageCacheKey(sessionId: string, messageId: string): string {
    return `${messageCacheSessionPrefix(sessionId)}${messageId}`;
}

/**
 * In-memory cache for decrypted session data to avoid expensive re-decryption
 * Uses sessionId + version as keys for agent state and metadata
 * Uses sessionId + messageId as keys for immutable messages
 */
export class EncryptionCache {
    private agentStateCache = new Map<string, CiphertextBoundCacheEntry<AgentState>>();
    private metadataCache = new Map<string, CiphertextBoundCacheEntry<Metadata>>();
    private messageCache = new Map<string, CacheEntry<DecryptedMessage>>();
    private machineMetadataCache = new Map<string, CacheEntry<MachineMetadata>>();
    private daemonStateCache = new Map<string, CacheEntry<any>>();

    // Configuration
    private readonly maxAgentStates = 1000;
    private readonly maxMetadata = 1000;
    private readonly maxMessages = 1000;
    private readonly maxMachineMetadata = 500;
    private readonly maxDaemonStates = 500;

    /**
     * Get cached agent state for a session
     */
    getCachedAgentState(
        sessionId: string,
        version: number,
        ciphertextCommitment: string,
    ): CiphertextBoundCacheLookup<AgentState> {
        const key = `${sessionId}:${version}`;
        const entry = this.agentStateCache.get(key);
        if (entry) {
            if (entry.ciphertextCommitment !== ciphertextCommitment) {
                return { status: 'conflict' };
            }
            entry.accessTime = Date.now();
            return { status: 'hit', data: entry.data };
        }
        return { status: 'miss' };
    }

    /**
     * Cache agent state for a session
     */
    setCachedAgentState(
        sessionId: string,
        version: number,
        ciphertextCommitment: string,
        data: AgentState,
    ): boolean {
        const key = `${sessionId}:${version}`;
        const existing = this.agentStateCache.get(key);
        if (existing) {
            if (existing.ciphertextCommitment !== ciphertextCommitment) {
                return false;
            }
            existing.accessTime = Date.now();
            return true;
        }
        this.agentStateCache.set(key, {
            data,
            ciphertextCommitment,
            accessTime: Date.now()
        });

        // Evict if over limit
        this.evictOldest(this.agentStateCache, this.maxAgentStates);
        return true;
    }

    /**
     * Get cached metadata for a session
     */
    getCachedMetadata(
        sessionId: string,
        version: number,
        ciphertextCommitment: string,
    ): CiphertextBoundCacheLookup<Metadata> {
        const key = `${sessionId}:${version}`;
        const entry = this.metadataCache.get(key);
        if (entry) {
            if (entry.ciphertextCommitment !== ciphertextCommitment) {
                return { status: 'conflict' };
            }
            entry.accessTime = Date.now();
            return { status: 'hit', data: entry.data };
        }
        return { status: 'miss' };
    }

    /**
     * Cache metadata for a session
     */
    setCachedMetadata(
        sessionId: string,
        version: number,
        ciphertextCommitment: string,
        data: Metadata,
    ): boolean {
        const key = `${sessionId}:${version}`;
        const existing = this.metadataCache.get(key);
        if (existing) {
            if (existing.ciphertextCommitment !== ciphertextCommitment) {
                return false;
            }
            existing.accessTime = Date.now();
            return true;
        }
        this.metadataCache.set(key, {
            data,
            ciphertextCommitment,
            accessTime: Date.now()
        });

        // Evict if over limit
        this.evictOldest(this.metadataCache, this.maxMetadata);
        return true;
    }

    /**
     * Get cached decrypted message
     */
    getCachedMessage(sessionId: string, messageId: string): DecryptedMessage | null {
        const entry = this.messageCache.get(messageCacheKey(sessionId, messageId));
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache decrypted message
     */
    setCachedMessage(sessionId: string, messageId: string, data: DecryptedMessage): void {
        this.messageCache.set(messageCacheKey(sessionId, messageId), {
            data,
            accessTime: Date.now()
        });

        // Evict if over limit
        this.evictOldest(this.messageCache, this.maxMessages);
    }

    /**
     * Get cached machine metadata
     */
    getCachedMachineMetadata(machineId: string, version: number): MachineMetadata | null {
        const key = `${machineId}:${version}`;
        const entry = this.machineMetadataCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return null;
    }

    /**
     * Cache machine metadata
     */
    setCachedMachineMetadata(machineId: string, version: number, data: MachineMetadata): void {
        const key = `${machineId}:${version}`;
        this.machineMetadataCache.set(key, {
            data,
            accessTime: Date.now()
        });

        // Evict if over limit
        this.evictOldest(this.machineMetadataCache, this.maxMachineMetadata);
    }

    /**
     * Get cached daemon state
     */
    getCachedDaemonState(machineId: string, version: number): any | undefined {
        const key = `${machineId}:${version}`;
        const entry = this.daemonStateCache.get(key);
        if (entry) {
            entry.accessTime = Date.now();
            return entry.data;
        }
        return undefined;
    }

    /**
     * Cache daemon state (including null values)
     */
    setCachedDaemonState(machineId: string, version: number, data: any): void {
        const key = `${machineId}:${version}`;
        this.daemonStateCache.set(key, {
            data,
            accessTime: Date.now()
        });

        // Evict if over limit
        this.evictOldest(this.daemonStateCache, this.maxDaemonStates);
    }

    /**
     * Clear all cache entries for a specific machine
     */
    clearMachineCache(machineId: string): void {
        // Clear machine metadata and daemon state for this machine (all versions)
        for (const key of this.machineMetadataCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.machineMetadataCache.delete(key);
            }
        }

        for (const key of this.daemonStateCache.keys()) {
            if (key.startsWith(`${machineId}:`)) {
                this.daemonStateCache.delete(key);
            }
        }
    }

    /**
     * Clear all cache entries for a specific session
     */
    clearSessionCache(sessionId: string): void {
        // Clear agent state and metadata for this session (all versions)
        for (const key of this.agentStateCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.agentStateCache.delete(key);
            }
        }

        for (const key of this.metadataCache.keys()) {
            if (key.startsWith(`${sessionId}:`)) {
                this.metadataCache.delete(key);
            }
        }

        const messagePrefix = messageCacheSessionPrefix(sessionId);
        for (const key of this.messageCache.keys()) {
            if (key.startsWith(messagePrefix)) {
                this.messageCache.delete(key);
            }
        }
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.agentStateCache.clear();
        this.metadataCache.clear();
        this.messageCache.clear();
        this.machineMetadataCache.clear();
        this.daemonStateCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats() {
        return {
            agentStates: this.agentStateCache.size,
            metadata: this.metadataCache.size,
            messages: this.messageCache.size,
            machineMetadata: this.machineMetadataCache.size,
            daemonStates: this.daemonStateCache.size,
            totalEntries: this.agentStateCache.size + this.metadataCache.size + this.messageCache.size +
                         this.machineMetadataCache.size + this.daemonStateCache.size
        };
    }

    /**
     * Evict oldest entries when cache exceeds limit (LRU eviction)
     */
    private evictOldest<T>(cache: Map<string, CacheEntry<T>>, maxSize: number): void {
        if (cache.size <= maxSize) {
            return;
        }

        // Find oldest entry by access time
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [key, entry] of cache.entries()) {
            if (entry.accessTime < oldestTime) {
                oldestTime = entry.accessTime;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }
}
