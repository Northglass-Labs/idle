export const RPC_REGISTRATION_CREDENTIAL_PURPOSE = 'rpc-registration-v1';

type SocketScopeType = 'user-scoped' | 'session-scoped' | 'machine-scoped';
type CredentialKind = 'ordinary' | 'rpc-registration' | 'legacy-terminal' | 'invalid';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function credentialKind(extras: unknown): CredentialKind {
    if (extras === undefined) {
        return 'ordinary';
    }
    if (!isRecord(extras)) {
        return 'invalid';
    }

    const keys = Object.keys(extras);
    if (keys.length === 0) {
        return 'ordinary';
    }
    if (
        keys.length === 1
        && keys[0] === 'credentialPurpose'
        && extras.credentialPurpose === RPC_REGISTRATION_CREDENTIAL_PURPOSE
    ) {
        return 'rpc-registration';
    }

    // Terminal pairing tokens issued before the dedicated credential split
    // carried exactly one opaque pairing-request marker. Keep that narrow
    // shape usable for HTTP and ordinary scoped sync during migration, but do
    // not grant RPC registration: possession of the persistent bearer alone
    // cannot prove that the caller is the terminal that originally paired.
    if (
        keys.length === 1
        && keys[0] === 'session'
        && typeof extras.session === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(extras.session)
    ) {
        return 'legacy-terminal';
    }

    return 'invalid';
}

export function canCredentialUseHttp(extras: unknown): boolean {
    const kind = credentialKind(extras);
    return kind === 'ordinary' || kind === 'legacy-terminal';
}

export function canCredentialUseSocketScope(extras: unknown, scope: SocketScopeType): boolean {
    const kind = credentialKind(extras);
    if (kind === 'invalid') {
        return false;
    }
    return kind !== 'rpc-registration' || scope !== 'user-scoped';
}

export function canCredentialRegisterRpc(extras: unknown): boolean {
    const kind = credentialKind(extras);
    return kind === 'rpc-registration';
}
