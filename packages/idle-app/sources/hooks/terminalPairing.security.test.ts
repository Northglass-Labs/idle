import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmPairing } = vi.hoisted(() => ({
    confirmPairing: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: confirmPairing,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import {
    parseTerminalAuthUrl,
    requestTerminalPairingConsent,
    terminalPublicKeyFingerprint,
} from './terminalPairing';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath: string) =>
    fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

function pairingFixture() {
    const publicKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const encoded = Buffer.from(publicKey).toString('base64url');
    return {
        publicKey,
        encoded,
        url: `idle://terminal?${encoded}`,
    };
}

describe('terminal pairing consent boundary', () => {
    beforeEach(() => {
        confirmPairing.mockReset();
    });

    it('accepts only a canonical 32-byte requester key', () => {
        const fixture = pairingFixture();
        expect(parseTerminalAuthUrl(fixture.url)).toEqual(fixture.publicKey);
        expect(() => parseTerminalAuthUrl('https://example.invalid/pair')).toThrow();
        expect(() => parseTerminalAuthUrl('idle://terminal?not-base64url!')).toThrow();
        expect(() => parseTerminalAuthUrl(`idle://terminal?${Buffer.alloc(31).toString('base64url')}`)).toThrow();
    });

    it('shows a full requester fingerprint derived from the exact key', () => {
        const fixture = pairingFixture();
        expect(terminalPublicKeyFingerprint(fixture.publicKey)).toBe(
            fixture.encoded.match(/.{1,4}/g)!.join(' '),
        );
    });

    it('does not invoke credential approval when the user cancels', async () => {
        const fixture = pairingFixture();
        const approve = vi.fn();
        confirmPairing.mockResolvedValue(false);

        await expect(requestTerminalPairingConsent(fixture.url, approve)).resolves.toBe(false);
        expect(approve).not.toHaveBeenCalled();
        expect(confirmPairing).toHaveBeenCalledTimes(1);
        expect(confirmPairing.mock.calls[0][1]).toContain(
            terminalPublicKeyFingerprint(fixture.publicKey),
        );
    });

    it('invokes credential approval once with the exact confirmed key', async () => {
        const fixture = pairingFixture();
        const approve = vi.fn().mockResolvedValue(undefined);
        confirmPairing.mockResolvedValue(true);

        await expect(requestTerminalPairingConsent(fixture.url, approve)).resolves.toBe(true);
        expect(approve).toHaveBeenCalledTimes(1);
        expect(approve.mock.calls[0][0]).toEqual(fixture.publicKey);
    });

    it('routes every QR, paste, native-link, and web-link entrypoint through the shared gate', () => {
        const hook = readSource('hooks/useConnectTerminal.ts');
        const nativeLink = readSource('app/(app)/terminal/index.tsx');
        const webLink = readSource('app/(app)/terminal/connect.tsx');
        const manualRestore = readSource('app/(app)/restore/manual.tsx');
        const consent = readSource('hooks/terminalPairing.ts');

        expect(consent.match(/Modal\.confirm/g)).toHaveLength(1);
        expect(hook).not.toMatch(/Modal\.confirm|processAuthUrl/);
        expect(hook).toMatch(/requestTerminalPairingConsent/);
        expect(hook).toMatch(/onScan:\s*requestTerminalPairing/);
        expect(nativeLink).toMatch(/requestTerminalPairing\(authUrl\)/);
        expect(webLink).toMatch(/requestTerminalPairing\(authUrl\)/);
        expect(manualRestore).toMatch(/autoCapitalize="none"/);
        expect(nativeLink).not.toMatch(/processAuthUrl/);
        expect(webLink).not.toMatch(/processAuthUrl/);
    });

    it('leaves first-run pairing immediately on success and opens session creation', () => {
        const hook = readSource('hooks/useConnectTerminal.ts');
        const emptyState = readSource('components/EmptyMainScreen.tsx');
        const nativeLink = readSource('app/(app)/terminal/index.tsx');

        expect(hook.indexOf('options?.onSuccess?.()')).toBeGreaterThan(-1);
        expect(hook.indexOf('options?.onSuccess?.()')).toBeLessThan(
            hook.indexOf("Modal.alert(t('common.success')"),
        );
        expect(emptyState).toMatch(/useConnectTerminal\(\{[\s\S]*router\.replace\('\/new'\)/);
        expect(nativeLink).toMatch(/onSuccess:[\s\S]*router\.replace\('\/new'\)/);
    });
});
