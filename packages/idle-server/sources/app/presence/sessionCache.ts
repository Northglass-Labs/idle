import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";
import { buildHeartbeatUpdateArgs } from "./sessionActivityUpdate";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

type ActivityCacheEntry = SessionCacheEntry | MachineCacheEntry;

type PendingActivityUpdate =
    | { type: 'session'; id: string; timestamp: number }
    | { type: 'machine'; id: string; timestamp: number; userId: string };

// Keep the in-memory heartbeat working set bounded independently of the
// persistent resource quotas enforced at the API boundary.
const MAX_CACHE_ENTRIES_PER_ACCOUNT = 256;
const MAX_CACHE_ENTRIES_PER_PROCESS = 4_096;
const MAX_FLUSH_BATCH_SIZE = 128;
const MAX_DATABASE_CONCURRENCY = 8;

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
            const item = items[nextIndex];
            nextIndex += 1;
            await worker(item);
        }
    }));
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private accountEntryCounts = new Map<string, number>();
    private batchTimer: ReturnType<typeof setInterval> | null = null;
    private flushInProgress = false;
    private flushSessionsFirst = true;

    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;

    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;

    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }

        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(() => {
                log({ module: 'session-cache', level: 'error' }, 'Activity cache flush failed');
            });
        }, this.BATCH_INTERVAL);
    }

    private incrementAccountEntries(userId: string): void {
        this.accountEntryCounts.set(userId, (this.accountEntryCounts.get(userId) ?? 0) + 1);
    }

    private decrementAccountEntries(userId: string): void {
        const next = (this.accountEntryCounts.get(userId) ?? 1) - 1;
        if (next <= 0) {
            this.accountEntryCounts.delete(userId);
        } else {
            this.accountEntryCounts.set(userId, next);
        }
    }

    private setCacheEntry<T extends ActivityCacheEntry>(cache: Map<string, T>, id: string, entry: T): void {
        const previous = cache.get(id);
        if (!previous) {
            this.incrementAccountEntries(entry.userId);
        } else if (previous.userId !== entry.userId) {
            this.decrementAccountEntries(previous.userId);
            this.incrementAccountEntries(entry.userId);
        }
        cache.set(id, entry);
    }

    private deleteCacheEntry<T extends ActivityCacheEntry>(cache: Map<string, T>, id: string): boolean {
        const entry = cache.get(id);
        if (!entry || !cache.delete(id)) {
            return false;
        }
        this.decrementAccountEntries(entry.userId);
        return true;
    }

    private pruneExpiredEntries(now: number): void {
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now && entry.pendingUpdate === null) {
                this.deleteCacheEntry(this.sessionCache, sessionId);
            }
        }
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now && entry.pendingUpdate === null) {
                this.deleteCacheEntry(this.machineCache, machineId);
            }
        }
    }

    private evictOldestIdleEntry(): boolean {
        let oldest: { type: 'session' | 'machine'; id: string; validUntil: number } | null = null;
        for (const [id, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate === null && (!oldest || entry.validUntil < oldest.validUntil)) {
                oldest = { type: 'session', id, validUntil: entry.validUntil };
            }
        }
        for (const [id, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate === null && (!oldest || entry.validUntil < oldest.validUntil)) {
                oldest = { type: 'machine', id, validUntil: entry.validUntil };
            }
        }
        if (!oldest) {
            return false;
        }
        return oldest.type === 'session'
            ? this.deleteCacheEntry(this.sessionCache, oldest.id)
            : this.deleteCacheEntry(this.machineCache, oldest.id);
    }

    private hasIdleEntry(): boolean {
        for (const entry of this.sessionCache.values()) {
            if (entry.pendingUpdate === null) return true;
        }
        for (const entry of this.machineCache.values()) {
            if (entry.pendingUpdate === null) return true;
        }
        return false;
    }

    private canAddCacheEntry(userId: string, now: number, makeRoom = false): boolean {
        this.pruneExpiredEntries(now);
        if ((this.accountEntryCounts.get(userId) ?? 0) >= MAX_CACHE_ENTRIES_PER_ACCOUNT) {
            return false;
        }
        const totalEntries = this.sessionCache.size + this.machineCache.size;
        if (totalEntries < MAX_CACHE_ENTRIES_PER_PROCESS) {
            return true;
        }

        return makeRoom ? this.evictOldestIdleEntry() : this.hasIdleEntry();
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.sessionCache.get(sessionId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }

        if (cached && cached.userId !== userId) {
            return false;
        }
        if (!cached && !this.canAddCacheEntry(userId, now)) {
            return false;
        }

        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const session = await db.session.findUnique({
                where: { id: sessionId, accountId: userId }
            });

            if (session) {
                const previous = this.sessionCache.get(sessionId);
                if (!previous && !this.canAddCacheEntry(userId, Date.now(), true)) {
                    return false;
                }
                this.setCacheEntry(this.sessionCache, sessionId, {
                    validUntil: Date.now() + this.CACHE_TTL,
                    lastUpdateSent: previous?.lastUpdateSent ?? session.lastActiveAt.getTime(),
                    pendingUpdate: previous?.pendingUpdate ?? null,
                    userId
                });
                return true;
            }

            if (cached) {
                this.deleteCacheEntry(this.sessionCache, sessionId);
            }

            return false;
        } catch {
            log({ module: 'session-cache', level: 'error' }, 'Session activity validation failed');
            return false;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }

        if (cached && cached.userId !== userId) {
            return false;
        }
        if (!cached && !this.canAddCacheEntry(userId, now)) {
            return false;
        }

        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });

            if (machine) {
                const previous = this.machineCache.get(machineId);
                if (!previous && !this.canAddCacheEntry(userId, Date.now(), true)) {
                    return false;
                }
                this.setCacheEntry(this.machineCache, machineId, {
                    validUntil: Date.now() + this.CACHE_TTL,
                    lastUpdateSent: previous?.lastUpdateSent ?? machine.lastActiveAt?.getTime() ?? 0,
                    pendingUpdate: previous?.pendingUpdate ?? null,
                    userId
                });
                return true;
            }

            if (cached) {
                this.deleteCacheEntry(this.machineCache, machineId);
            }

            return false;
        } catch {
            log({ module: 'session-cache', level: 'error' }, 'Machine activity validation failed');
            return false;
        }
    }

    queueSessionUpdate(sessionId: string, timestamp: number): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }

        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }

        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }

        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    private async flushPendingUpdates(): Promise<void> {
        if (this.flushInProgress) {
            return;
        }
        this.flushInProgress = true;
        try {
            const updates: PendingActivityUpdate[] = [];
            const collectSessions = () => {
                for (const [id, entry] of this.sessionCache.entries()) {
                    if (updates.length >= MAX_FLUSH_BATCH_SIZE) break;
                    if (entry.pendingUpdate !== null) {
                        updates.push({ type: 'session', id, timestamp: entry.pendingUpdate });
                    }
                }
            };
            const collectMachines = () => {
                for (const [id, entry] of this.machineCache.entries()) {
                    if (updates.length >= MAX_FLUSH_BATCH_SIZE) break;
                    if (entry.pendingUpdate !== null) {
                        updates.push({ type: 'machine', id, timestamp: entry.pendingUpdate, userId: entry.userId });
                    }
                }
            };

            if (this.flushSessionsFirst) {
                collectSessions();
                collectMachines();
            } else {
                collectMachines();
                collectSessions();
            }
            this.flushSessionsFirst = !this.flushSessionsFirst;

            let sessionSuccesses = 0;
            let machineSuccesses = 0;
            let failures = 0;
            await runWithConcurrency(updates, MAX_DATABASE_CONCURRENCY, async (update) => {
                try {
                    if (update.type === 'session') {
                        // Preserve the active:true guard that prevents phantom heartbeats
                        // from resurrecting a timed-out session.
                        await db.session.updateMany(buildHeartbeatUpdateArgs({
                            sessionId: update.id,
                            timestamp: update.timestamp,
                        }));
                        const entry = this.sessionCache.get(update.id);
                        if (entry) {
                            entry.lastUpdateSent = update.timestamp;
                            if (entry.pendingUpdate === update.timestamp) entry.pendingUpdate = null;
                        }
                        sessionSuccesses += 1;
                    } else {
                        await db.machine.update({
                            where: {
                                accountId_id: {
                                    accountId: update.userId,
                                    id: update.id
                                }
                            },
                            data: { lastActiveAt: new Date(update.timestamp) }
                        });
                        const entry = this.machineCache.get(update.id);
                        if (entry) {
                            entry.lastUpdateSent = update.timestamp;
                            if (entry.pendingUpdate === update.timestamp) entry.pendingUpdate = null;
                        }
                        machineSuccesses += 1;
                    }
                } catch {
                    failures += 1;
                }
            });

            if (sessionSuccesses > 0) {
                log({ module: 'session-cache', updatedCount: sessionSuccesses }, 'Flushed session activity updates');
            }
            if (machineSuccesses > 0) {
                log({ module: 'session-cache', updatedCount: machineSuccesses }, 'Flushed machine activity updates');
            }
            if (failures > 0) {
                log({ module: 'session-cache', level: 'error', failedCount: failures }, 'Activity cache updates failed');
            }
        } finally {
            this.flushInProgress = false;
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        this.pruneExpiredEntries(Date.now());
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }

        // Flush any remaining updates
        this.flushPendingUpdates().catch(() => {
            log({ module: 'session-cache', level: 'error' }, 'Final activity cache flush failed');
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);
