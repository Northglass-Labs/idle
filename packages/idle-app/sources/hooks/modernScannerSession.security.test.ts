import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath: string) =>
    fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

describe('modern QR scanner release boundary', () => {
    it('keeps terminal and account scans on one tested lifecycle controller', () => {
        const controller = readSource('hooks/modernScannerSession.ts');

        expect(controller).toMatch(/export function createModernScannerSession/);
        expect(controller).toMatch(/SCANNER_SESSION_TIMEOUT_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
        expect(controller).toMatch(/await camera\.dismissScanner\(\)/);
        expect(controller).toMatch(/isGuidanceEnabled:\s*false/);
        expect(controller).toMatch(/isHighlightingEnabled:\s*true/);

        for (const hookPath of [
            'hooks/useConnectTerminal.ts',
            'hooks/useConnectAccount.ts',
        ]) {
            const hook = readSource(hookPath);
            expect(hook).toMatch(/createModernScannerSession/);
            expect(hook).not.toMatch(/onModernBarcodeScanned|setTimeout\(/);
            expect(hook).not.toMatch(/15\s*\*\s*1000/);
        }
    });
});
