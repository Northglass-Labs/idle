const DEFAULT_MAX_PENDING_PER_ACCOUNT = 100;
const DEFAULT_MAX_PENDING_TOTAL = 10_000;
const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

type AdmissionStatus = 'pending' | 'canceled' | 'promoted' | 'released' | 'expired';

interface PendingSocketAdmissionsOptions {
    maxPerAccount?: number;
    maxTotal?: number;
    timeoutMs?: number;
}

export class PendingSocketAdmission {
    private status: AdmissionStatus = 'pending';
    private readonly timeout: ReturnType<typeof setTimeout>;

    constructor(
        readonly userId: string,
        readonly socketId: string,
        private readonly owner: PendingSocketAdmissions,
        timeoutMs: number,
    ) {
        this.timeout = setTimeout(() => this.expire(), timeoutMs);
        this.timeout.unref?.();
    }

    get canceled(): boolean {
        return this.status === 'canceled' || this.status === 'expired';
    }

    cancel(): boolean {
        if (this.status !== 'pending') return false;
        this.status = 'canceled';
        return true;
    }

    promote(): boolean {
        if (this.status === 'pending') {
            this.status = 'promoted';
            this.finish();
            return true;
        }
        if (this.status === 'canceled' || this.status === 'expired') {
            this.finish();
        }
        return false;
    }

    release(): void {
        if (this.status === 'promoted' || this.status === 'released') return;
        if (this.status === 'pending') this.status = 'released';
        this.finish();
    }

    private expire(): void {
        if (this.status !== 'pending') return;
        this.status = 'expired';
        this.owner.remove(this);
    }

    private finish(): void {
        clearTimeout(this.timeout);
        this.owner.remove(this);
    }
}

/**
 * Bounded process-local registry for Socket.IO namespace admissions that have
 * passed their first bearer check but are not yet established. Revocation
 * cancels these records before sweeping established account rooms.
 */
export class PendingSocketAdmissions {
    private readonly byUser = new Map<string, Map<string, PendingSocketAdmission>>();
    private total = 0;
    private readonly maxPerAccount: number;
    private readonly maxTotal: number;
    private readonly timeoutMs: number;

    constructor(options: PendingSocketAdmissionsOptions = {}) {
        this.maxPerAccount = options.maxPerAccount ?? DEFAULT_MAX_PENDING_PER_ACCOUNT;
        this.maxTotal = options.maxTotal ?? DEFAULT_MAX_PENDING_TOTAL;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
    }

    track(userId: string, socketId: string): PendingSocketAdmission | null {
        const accountAdmissions = this.byUser.get(userId) ?? new Map<string, PendingSocketAdmission>();
        if (
            this.total >= this.maxTotal
            || accountAdmissions.size >= this.maxPerAccount
            || accountAdmissions.has(socketId)
        ) {
            return null;
        }

        const admission = new PendingSocketAdmission(userId, socketId, this, this.timeoutMs);
        accountAdmissions.set(socketId, admission);
        this.byUser.set(userId, accountAdmissions);
        this.total++;
        return admission;
    }

    get(userId: string, socketId: string): PendingSocketAdmission | undefined {
        return this.byUser.get(userId)?.get(socketId);
    }

    cancelUser(userId: string): number {
        let canceled = 0;
        for (const admission of this.byUser.get(userId)?.values() ?? []) {
            if (admission.cancel()) canceled++;
        }
        return canceled;
    }

    stats(): { accounts: number; admissions: number } {
        return { accounts: this.byUser.size, admissions: this.total };
    }

    remove(admission: PendingSocketAdmission): void {
        const accountAdmissions = this.byUser.get(admission.userId);
        if (accountAdmissions?.get(admission.socketId) !== admission) return;
        accountAdmissions.delete(admission.socketId);
        this.total--;
        if (accountAdmissions.size === 0) this.byUser.delete(admission.userId);
    }
}

export const pendingSocketAdmissions = new PendingSocketAdmissions();
