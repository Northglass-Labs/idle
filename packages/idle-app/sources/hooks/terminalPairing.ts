import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import { t } from '@/text';

const TERMINAL_AUTH_PREFIX = 'idle://terminal?';
const CANONICAL_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

export class InvalidTerminalAuthUrlError extends Error {
    constructor() {
        super('Invalid terminal authentication URL');
        this.name = 'InvalidTerminalAuthUrlError';
    }
}

export function parseTerminalAuthUrl(url: string): Uint8Array {
    if (!url.startsWith(TERMINAL_AUTH_PREFIX)) {
        throw new InvalidTerminalAuthUrlError();
    }
    const encoded = url.slice(TERMINAL_AUTH_PREFIX.length);
    if (!CANONICAL_PUBLIC_KEY.test(encoded)) {
        throw new InvalidTerminalAuthUrlError();
    }

    try {
        const publicKey = decodeBase64(encoded, 'base64url');
        if (
            publicKey.length !== 32
            || encodeBase64(publicKey, 'base64url') !== encoded
        ) {
            throw new InvalidTerminalAuthUrlError();
        }
        return publicKey;
    } catch (error) {
        if (error instanceof InvalidTerminalAuthUrlError) throw error;
        throw new InvalidTerminalAuthUrlError();
    }
}

export function terminalPublicKeyFingerprint(publicKey: Uint8Array): string {
    if (publicKey.length !== 32) throw new InvalidTerminalAuthUrlError();
    return encodeBase64(publicKey, 'base64url').match(/.{1,4}/g)!.join(' ');
}

export async function requestTerminalPairingConsent(
    url: string,
    approve: (publicKey: Uint8Array) => Promise<void>,
): Promise<boolean> {
    const publicKey = parseTerminalAuthUrl(url);
    const fingerprint = terminalPublicKeyFingerprint(publicKey);
    const approved = await Modal.confirm(
        t('terminal.pairingGrantTitle'),
        `${t('terminal.pairingGrantDescription')}\n\n${t('terminal.publicKey')}:\n${fingerprint}`,
        {
            cancelText: t('common.cancel'),
            confirmText: t('terminal.pairTerminal'),
            destructive: true,
        },
    );
    if (!approved) return false;

    await approve(publicKey);
    return true;
}
