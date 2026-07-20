import type { Socket } from 'socket.io';

import {
    canCredentialRegisterRpc,
    canCredentialUseSocketScope,
} from '@/app/auth/credentialPurpose';
import {
    authorizeSocketScope,
    type AuthorizedSocketScope,
} from './socketScope';
import type { PendingSocketAdmissions } from './pendingSocketAdmissions';

interface VerifiedSocketCredential {
    userId: string;
    extras?: unknown;
    authorizationGeneration: number;
}

interface SocketAdmissionAuth {
    verifyToken(token: string): Promise<VerifiedSocketCredential | null>;
}

interface SocketOwnershipLookup {
    getSessionGeneration(accountId: string, sessionId: string): Promise<number | null>;
    getMachineGeneration(accountId: string, machineId: string): Promise<number | null>;
}

type AdmissionSocket = Pick<Socket, 'id' | 'data' | 'join' | 'conn'>;

type SocketAdmissionResult =
    | {
        ok: true;
        scope: AuthorizedSocketScope;
        credential: VerifiedSocketCredential;
    }
    | { ok: false; error: string };

export async function prepareSocketAdmission(params: {
    socket: AdmissionSocket;
    token: string;
    claim: { clientType?: unknown; sessionId?: unknown; machineId?: unknown };
    auth: SocketAdmissionAuth;
    ownership: SocketOwnershipLookup;
    admissions: PendingSocketAdmissions;
}): Promise<SocketAdmissionResult> {
    const initial = await params.auth.verifyToken(params.token);
    if (!initial) return { ok: false, error: 'Invalid authentication token' };

    const admission = params.admissions.track(initial.userId, params.socket.id);
    if (!admission) {
        return { ok: false, error: 'Too many socket admissions in progress' };
    }
    params.socket.conn.once('close', () => admission.release());

    const reject = (error: string): SocketAdmissionResult => {
        admission.release();
        return { ok: false, error };
    };

    try {
        const scopeAuthorization = await authorizeSocketScope(
            initial.userId,
            params.claim,
            params.ownership,
        );
        if (!scopeAuthorization.ok) return reject(scopeAuthorization.error);
        if (!canCredentialUseSocketScope(initial.extras, scopeAuthorization.scope.clientType)) {
            return reject('Credential is not authorized for this socket scope');
        }

        // The ownership lookup above is asynchronous. Re-verify the exact
        // bearer generation after it completes, while the pending admission is
        // still visible to account suspension on every relay.
        const current = await params.auth.verifyToken(params.token);
        if (
            !current
            || current.userId !== initial.userId
            || current.authorizationGeneration !== initial.authorizationGeneration
            || admission.canceled
        ) {
            return reject('Authentication changed during socket admission');
        }

        params.socket.data.userId = current.userId;
        params.socket.data.clientType = scopeAuthorization.scope.clientType;
        params.socket.data.sessionId = scopeAuthorization.scope.clientType === 'session-scoped'
            ? scopeAuthorization.scope.sessionId
            : undefined;
        params.socket.data.machineId = scopeAuthorization.scope.clientType === 'machine-scoped'
            ? scopeAuthorization.scope.machineId
            : undefined;
        params.socket.data.authorizationGeneration = scopeAuthorization.scope.clientType !== 'user-scoped'
            ? scopeAuthorization.scope.authorizationGeneration
            : undefined;
        params.socket.data.accountAuthorizationGeneration = current.authorizationGeneration;
        params.socket.data.rpcRegistrationAuthorized = scopeAuthorization.scope.clientType !== 'user-scoped'
            && canCredentialRegisterRpc(current.extras);

        // Join the established account revocation room before the pending
        // record is promoted. Middleware-stage sockets remain covered by the
        // explicit registry because Socket.IO does not expose them to adapter
        // disconnects until namespace admission completes.
        await params.socket.join(`user:${current.userId}`);
        if (admission.canceled) {
            return reject('Authentication changed during socket admission');
        }

        return { ok: true, scope: scopeAuthorization.scope, credential: current };
    } catch {
        return reject('Socket authorization failed');
    }
}
