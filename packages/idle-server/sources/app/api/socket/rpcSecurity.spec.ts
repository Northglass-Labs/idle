import { describe, expect, it } from 'vitest';

import {
    MAX_RPC_INFLIGHT_PER_ACCOUNT,
    MAX_RPC_INFLIGHT_PER_SOCKET,
    MAX_RPC_RESULT_BYTES,
    MAX_RPC_REGISTRATIONS_PER_ACCOUNT,
    MAX_RPC_REGISTRATIONS_PER_SOCKET,
    RpcInFlightLimiter,
    RpcRegistrationLimiter,
    canRegisterRpcMethod,
    isBoundedRpcResult,
} from './rpcSecurity';

describe('RPC authorization and resource boundaries', () => {
    it('allows only a session socket to register its own session prefix', () => {
        const scope = {
            connectionType: 'session-scoped' as const,
            sessionId: 'session-1',
            rpcRegistrationAuthorized: true,
        };

        expect(canRegisterRpcMethod(scope, 'session-1:bash')).toBe(true);
        expect(canRegisterRpcMethod(scope, 'session-2:bash')).toBe(false);
        expect(canRegisterRpcMethod(scope, 'session-1:bash:other')).toBe(false);
    });

    it('allows only a machine socket to register its own machine prefix', () => {
        const scope = {
            connectionType: 'machine-scoped' as const,
            machineId: 'machine-1',
            rpcRegistrationAuthorized: true,
        };

        expect(canRegisterRpcMethod(scope, 'machine-1:spawn-idle-session')).toBe(true);
        expect(canRegisterRpcMethod(scope, 'machine-2:spawn-idle-session')).toBe(false);
    });

    it('does not let user-scoped sockets register RPC handlers', () => {
        expect(canRegisterRpcMethod({ connectionType: 'user-scoped' }, 'session-1:bash')).toBe(false);
    });

    it('does not let an ordinary bearer register an owned scoped RPC handler', () => {
        expect(canRegisterRpcMethod({
            connectionType: 'session-scoped',
            sessionId: 'session-1',
            rpcRegistrationAuthorized: false,
        }, 'session-1:bash')).toBe(false);
        expect(canRegisterRpcMethod({
            connectionType: 'machine-scoped',
            machineId: 'machine-1',
            rpcRegistrationAuthorized: false,
        }, 'machine-1:spawn-idle-session')).toBe(false);
    });

    it('caps registrations per socket and releases them on disconnect', () => {
        const limiter = new RpcRegistrationLimiter();
        const lease = limiter.createLease('account-1');

        for (let index = 0; index < MAX_RPC_REGISTRATIONS_PER_SOCKET; index++) {
            expect(lease.register(`session-1:method-${index}`)).toBe('registered');
        }
        expect(lease.register('session-1:one-too-many')).toBe('socket-limit');
        expect(lease.register('session-1:method-0')).toBe('duplicate');

        lease.releaseAll();
        expect(limiter.getAccountRegistrationCount('account-1')).toBe(0);
    });

    it('caps registrations across sockets for one account', () => {
        const limiter = new RpcRegistrationLimiter();
        const leases = Array.from(
            { length: Math.ceil(MAX_RPC_REGISTRATIONS_PER_ACCOUNT / MAX_RPC_REGISTRATIONS_PER_SOCKET) },
            () => limiter.createLease('account-1'),
        );

        let registered = 0;
        for (const lease of leases) {
            while (registered < MAX_RPC_REGISTRATIONS_PER_ACCOUNT) {
                const outcome = lease.register(`scope-${registered}:method`);
                if (outcome !== 'registered') break;
                registered++;
            }
        }

        expect(registered).toBe(MAX_RPC_REGISTRATIONS_PER_ACCOUNT);
        expect(limiter.createLease('account-1').register('extra:method')).toBe('account-limit');
    });

    it('caps in-flight RPC work per socket and account', () => {
        const limiter = new RpcInFlightLimiter();
        const first = limiter.createLease('account-1');
        const firstReleases = Array.from(
            { length: MAX_RPC_INFLIGHT_PER_SOCKET },
            () => first.tryAcquire(),
        );
        expect(firstReleases.every(Boolean)).toBe(true);
        expect(first.tryAcquire()).toBeNull();

        const otherReleases: Array<() => void> = [];
        while (otherReleases.length + firstReleases.length < MAX_RPC_INFLIGHT_PER_ACCOUNT) {
            const release = limiter.createLease('account-1').tryAcquire();
            expect(release).not.toBeNull();
            otherReleases.push(release!);
        }
        expect(limiter.createLease('account-1').tryAcquire()).toBeNull();

        firstReleases[0]!();
        expect(limiter.createLease('account-1').tryAcquire()).not.toBeNull();
    });

    it('rejects non-string and oversized RPC results', () => {
        expect(isBoundedRpcResult('encrypted-response')).toBe(true);
        expect(isBoundedRpcResult({ encrypted: 'response' })).toBe(false);
        expect(isBoundedRpcResult('x'.repeat(MAX_RPC_RESULT_BYTES + 1))).toBe(false);
    });
});
