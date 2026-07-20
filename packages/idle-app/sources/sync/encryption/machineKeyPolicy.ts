export type MachineDataKeyResolution =
    | { kind: 'legacy' }
    | { kind: 'current'; key: Uint8Array }
    | { kind: 'invalid' };

/**
 * Distinguish an explicitly legacy machine from a present current-key bundle
 * that failed authentication. Conflating those states silently downgraded an
 * isolated machine to the account-wide legacy encryptor.
 */
export async function resolveMachineDataKey(
    encryptedKey: string | null | undefined,
    decrypt: (encryptedKey: string) => Promise<Uint8Array | null>,
): Promise<MachineDataKeyResolution> {
    if (encryptedKey === null || encryptedKey === undefined) {
        return { kind: 'legacy' };
    }

    try {
        const key = await decrypt(encryptedKey);
        return key ? { kind: 'current', key } : { kind: 'invalid' };
    } catch {
        return { kind: 'invalid' };
    }
}
