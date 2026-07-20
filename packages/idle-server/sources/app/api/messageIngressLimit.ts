type MessageByteLimiterOptions = {
    maxBytesPerAccount: number;
    maxRequestsPerAccount: number;
    maxBytesTotal: number;
    maxRequestsTotal: number;
};

type AccountUsage = {
    bytes: number;
    requests: number;
};

const DEFAULT_OPTIONS: MessageByteLimiterOptions = {
    maxBytesPerAccount: 12 * 1024 * 1024,
    maxRequestsPerAccount: 2,
    maxBytesTotal: 64 * 1024 * 1024,
    maxRequestsTotal: 16,
};

function assertPositiveSafeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
}

/**
 * Bounds authenticated request bodies before Fastify buffers and parses them.
 * Entries only exist for active requests, so rotating account identifiers
 * cannot grow this map beyond the global request limit.
 */
export class InFlightMessageByteLimiter {
    private readonly options: MessageByteLimiterOptions;
    private readonly accounts = new Map<string, AccountUsage>();
    private totalBytes = 0;
    private totalRequests = 0;

    constructor(options: MessageByteLimiterOptions = DEFAULT_OPTIONS) {
        assertPositiveSafeInteger('maxBytesPerAccount', options.maxBytesPerAccount);
        assertPositiveSafeInteger('maxRequestsPerAccount', options.maxRequestsPerAccount);
        assertPositiveSafeInteger('maxBytesTotal', options.maxBytesTotal);
        assertPositiveSafeInteger('maxRequestsTotal', options.maxRequestsTotal);
        this.options = { ...options };
    }

    tryAcquire(accountId: string, bytes: number): (() => void) | null {
        if (accountId.length === 0 || !Number.isSafeInteger(bytes) || bytes < 1) {
            return null;
        }

        const account = this.accounts.get(accountId) ?? { bytes: 0, requests: 0 };
        if (
            account.bytes + bytes > this.options.maxBytesPerAccount
            || account.requests + 1 > this.options.maxRequestsPerAccount
            || this.totalBytes + bytes > this.options.maxBytesTotal
            || this.totalRequests + 1 > this.options.maxRequestsTotal
        ) {
            return null;
        }

        account.bytes += bytes;
        account.requests += 1;
        this.accounts.set(accountId, account);
        this.totalBytes += bytes;
        this.totalRequests += 1;

        let released = false;
        return () => {
            if (released) return;
            released = true;

            const current = this.accounts.get(accountId);
            if (!current) return;
            current.bytes -= bytes;
            current.requests -= 1;
            this.totalBytes -= bytes;
            this.totalRequests -= 1;
            if (current.requests === 0) {
                this.accounts.delete(accountId);
            }
        };
    }

    stats(): { bytes: number; requests: number; accounts: number } {
        return {
            bytes: this.totalBytes,
            requests: this.totalRequests,
            accounts: this.accounts.size,
        };
    }
}

export const messageIngressLimiter = new InFlightMessageByteLimiter();
