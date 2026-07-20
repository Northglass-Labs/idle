const MAX_RPC_RESULT_BYTES = 24 * 1024 * 1024;

export { MAX_RPC_RESULT_BYTES };
export const MAX_RPC_REGISTRATIONS_PER_SOCKET = 32;
export const MAX_RPC_REGISTRATIONS_PER_ACCOUNT = 128;
export const MAX_RPC_INFLIGHT_PER_SOCKET = 8;
export const MAX_RPC_INFLIGHT_PER_ACCOUNT = 32;

type RpcRegistrationScope =
    | { connectionType: 'user-scoped' }
    | { connectionType: 'session-scoped'; sessionId: string; rpcRegistrationAuthorized?: boolean }
    | { connectionType: 'machine-scoped'; machineId: string; rpcRegistrationAuthorized?: boolean };

export function canRegisterRpcMethod(scope: RpcRegistrationScope, method: string): boolean {
    if (scope.connectionType === 'user-scoped' || scope.rpcRegistrationAuthorized !== true) {
        return false;
    }
    const expectedPrefix = scope.connectionType === 'session-scoped'
        ? `${scope.sessionId}:`
        : `${scope.machineId}:`;
    if (!method.startsWith(expectedPrefix)) {
        return false;
    }
    const baseMethod = method.slice(expectedPrefix.length);
    return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(baseMethod);
}

export function isBoundedRpcResult(value: unknown): value is string {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_RPC_RESULT_BYTES;
}

type RegistrationOutcome = 'registered' | 'duplicate' | 'socket-limit' | 'account-limit';

export class RpcRegistrationLimiter {
    private readonly accountCounts = new Map<string, number>();

    createLease(accountId: string) {
        const registered = new Set<string>();
        const decrementAccount = () => {
            const next = Math.max(0, (this.accountCounts.get(accountId) ?? 0) - 1);
            if (next === 0) this.accountCounts.delete(accountId);
            else this.accountCounts.set(accountId, next);
        };

        return {
            register: (method: string): RegistrationOutcome => {
                if (registered.has(method)) return 'duplicate';
                if (registered.size >= MAX_RPC_REGISTRATIONS_PER_SOCKET) return 'socket-limit';
                const accountCount = this.accountCounts.get(accountId) ?? 0;
                if (accountCount >= MAX_RPC_REGISTRATIONS_PER_ACCOUNT) return 'account-limit';
                registered.add(method);
                this.accountCounts.set(accountId, accountCount + 1);
                return 'registered';
            },
            unregister: (method: string): boolean => {
                if (!registered.delete(method)) return false;
                decrementAccount();
                return true;
            },
            releaseAll: (): void => {
                const released = registered.size;
                registered.clear();
                if (released === 0) return;
                const next = Math.max(0, (this.accountCounts.get(accountId) ?? 0) - released);
                if (next === 0) this.accountCounts.delete(accountId);
                else this.accountCounts.set(accountId, next);
            },
        };
    }

    getAccountRegistrationCount(accountId: string): number {
        return this.accountCounts.get(accountId) ?? 0;
    }
}

export class RpcInFlightLimiter {
    private readonly accountCounts = new Map<string, number>();

    createLease(accountId: string) {
        let socketCount = 0;
        return {
            tryAcquire: (): (() => void) | null => {
                const accountCount = this.accountCounts.get(accountId) ?? 0;
                if (
                    socketCount >= MAX_RPC_INFLIGHT_PER_SOCKET
                    || accountCount >= MAX_RPC_INFLIGHT_PER_ACCOUNT
                ) {
                    return null;
                }
                socketCount++;
                this.accountCounts.set(accountId, accountCount + 1);
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    socketCount = Math.max(0, socketCount - 1);
                    const next = Math.max(0, (this.accountCounts.get(accountId) ?? 0) - 1);
                    if (next === 0) this.accountCounts.delete(accountId);
                    else this.accountCounts.set(accountId, next);
                };
            },
        };
    }
}

export const rpcRegistrationLimiter = new RpcRegistrationLimiter();
export const rpcInFlightLimiter = new RpcInFlightLimiter();
