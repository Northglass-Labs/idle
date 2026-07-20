type AttachmentTransferLimitOptions = {
    maxBytesPerAccount: number;
    maxTransfersPerAccount: number;
    maxBytesTotal: number;
    maxTransfersTotal: number;
};

type AccountUsage = {
    bytes: number;
    transfers: number;
};

const DEFAULT_OPTIONS: AttachmentTransferLimitOptions = {
    maxBytesPerAccount: 40 * 1024 * 1024,
    maxTransfersPerAccount: 4,
    maxBytesTotal: 128 * 1024 * 1024,
    maxTransfersTotal: 16,
};

function assertPositiveSafeInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
}

/** Shared upload/download budget for encrypted attachment bytes in this relay. */
export class InFlightAttachmentTransferLimiter {
    private readonly options: AttachmentTransferLimitOptions;
    private readonly accounts = new Map<string, AccountUsage>();
    private totalBytes = 0;
    private totalTransfers = 0;

    constructor(options: AttachmentTransferLimitOptions = DEFAULT_OPTIONS) {
        assertPositiveSafeInteger('maxBytesPerAccount', options.maxBytesPerAccount);
        assertPositiveSafeInteger('maxTransfersPerAccount', options.maxTransfersPerAccount);
        assertPositiveSafeInteger('maxBytesTotal', options.maxBytesTotal);
        assertPositiveSafeInteger('maxTransfersTotal', options.maxTransfersTotal);
        this.options = { ...options };
    }

    tryAcquire(accountId: string, bytes: number): (() => void) | null {
        if (accountId.length === 0 || !Number.isSafeInteger(bytes) || bytes < 1) return null;

        const account = this.accounts.get(accountId) ?? { bytes: 0, transfers: 0 };
        if (
            account.bytes + bytes > this.options.maxBytesPerAccount
            || account.transfers + 1 > this.options.maxTransfersPerAccount
            || this.totalBytes + bytes > this.options.maxBytesTotal
            || this.totalTransfers + 1 > this.options.maxTransfersTotal
        ) {
            return null;
        }

        account.bytes += bytes;
        account.transfers += 1;
        this.accounts.set(accountId, account);
        this.totalBytes += bytes;
        this.totalTransfers += 1;

        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = this.accounts.get(accountId);
            if (!current) return;
            current.bytes -= bytes;
            current.transfers -= 1;
            this.totalBytes -= bytes;
            this.totalTransfers -= 1;
            if (current.transfers === 0) this.accounts.delete(accountId);
        };
    }

    stats(): { bytes: number; transfers: number; accounts: number } {
        return {
            bytes: this.totalBytes,
            transfers: this.totalTransfers,
            accounts: this.accounts.size,
        };
    }
}

export const attachmentTransferLimiter = new InFlightAttachmentTransferLimiter();
