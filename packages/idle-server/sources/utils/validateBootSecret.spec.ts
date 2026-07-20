import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeBootSecret, loadBootSecret, validateBootSecret } from './validateBootSecret';

const temporaryDirectories: string[] = [];

function createSecretFile(contents: string, mode = 0o600): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-master-secret-'));
    temporaryDirectories.push(directory);
    const secretPath = path.join(directory, 'master-secret');
    fs.writeFileSync(secretPath, contents, { encoding: 'utf8', mode });
    fs.chmodSync(secretPath, mode);
    return secretPath;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('validateBootSecret', () => {
    it('rejects undefined with an actionable error message', () => {
        const r = validateBootSecret(undefined);
        expect(r.ok).toBe(false);
        expect(r.error).toContain('IDLE_MASTER_SECRET is not set');
        expect(r.error).toContain('openssl rand -hex 32');
        expect(r.error).toContain('SELF-HOSTING.md');
    });

    it('rejects null the same way as undefined', () => {
        expect(validateBootSecret(null).ok).toBe(false);
    });

    it('rejects empty string with a specific "empty string" phrasing', () => {
        const r = validateBootSecret('');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('empty string');
    });

    it('rejects the committed development placeholder', () => {
        const r = validateBootSecret('your-super-secret-key-for-local-development');
        expect(r.ok).toBe(false);
        expect(r.error).toContain('placeholder');
        expect(r.error).toContain('forge authentication tokens');
        expect(r.error).toContain('decrypt a retained legacy GitHub OAuth token');
        expect(r.error).not.toContain('stored service credentials');
        expect(r.error).not.toContain('decrypt sessions');
    });

    it('rejects common placeholders ("change-me", "changeme", "secret", "password")', () => {
        for (const p of ['change-me', 'changeme', 'changeMe', 'CHANGEME', 'secret', 'password', 'idle-master-secret']) {
            const r = validateBootSecret(p);
            expect(r.ok, `expected "${p}" rejected`).toBe(false);
        }
    });

    it('rejects secrets shorter than 64 chars with a length-specific error', () => {
        const r = validateBootSecret('a'.repeat(31));
        expect(r.ok).toBe(false);
        expect(r.error).toContain('64 hexadecimal');
        expect(r.error).toContain('31');
    });

    it('rejects weak, non-hex, and non-canonical secret values', () => {
        for (const secret of [
            'a'.repeat(32),
            'z'.repeat(64),
            'a'.repeat(63),
            'a'.repeat(65),
            '00'.repeat(32) + ' trailing',
        ]) {
            expect(validateBootSecret(secret).ok, `expected ${secret.length}-char value rejected`).toBe(false);
        }
    });

    it('accepts the canonical `openssl rand -hex 32` output (64 hex chars)', () => {
        const real = 'b7'.repeat(32);
        expect(real).toHaveLength(64);
        expect(validateBootSecret(real).ok).toBe(true);
    });

    it('accepts uppercase hexadecimal without weakening the 32-byte policy', () => {
        expect(validateBootSecret('A0'.repeat(32)).ok).toBe(true);
    });

    it('returns no error string when ok', () => {
        const r = validateBootSecret('a'.repeat(64));
        expect(r.ok).toBe(true);
        expect(r.error).toBeUndefined();
    });
});

describe('loadBootSecret', () => {
    const secret = 'a0'.repeat(32);

    it('loads the canonical value directly from the process environment', () => {
        expect(loadBootSecret({ IDLE_MASTER_SECRET: secret })).toBe(secret);
    });

    it('loads an owner-only regular secret file with an optional single LF', () => {
        const exactPath = createSecretFile(secret);
        const newlinePath = createSecretFile(`${secret}\n`);
        const readOnlyPath = createSecretFile(secret, 0o400);

        expect(loadBootSecret({ IDLE_MASTER_SECRET_FILE: exactPath })).toBe(secret);
        expect(loadBootSecret({ IDLE_MASTER_SECRET_FILE: newlinePath })).toBe(secret);
        expect(loadBootSecret({ IDLE_MASTER_SECRET_FILE: readOnlyPath })).toBe(secret);
    });

    it('requires exactly one unambiguous source', () => {
        expect(() => loadBootSecret({})).toThrow(/exactly one/i);
        expect(() => loadBootSecret({
            IDLE_MASTER_SECRET: secret,
            IDLE_MASTER_SECRET_FILE: createSecretFile(secret),
        })).toThrow(/exactly one/i);
        expect(() => loadBootSecret({
            IDLE_MASTER_SECRET: '',
            IDLE_MASTER_SECRET_FILE: createSecretFile(secret),
        })).toThrow(/exactly one/i);
    });

    it('rejects relative, missing, symlinked, non-regular, and multiply-linked files', () => {
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: 'master-secret' }))
            .toThrow(/absolute/i);

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-master-secret-invalid-'));
        temporaryDirectories.push(directory);
        const missing = path.join(directory, 'missing');
        const target = path.join(directory, 'target');
        const symlink = path.join(directory, 'symlink');
        const hardlink = path.join(directory, 'hardlink');
        fs.writeFileSync(target, secret, { mode: 0o600 });
        fs.symlinkSync(target, symlink);
        fs.linkSync(target, hardlink);

        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: missing })).toThrow(/unavailable/i);
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: symlink })).toThrow(/regular file/i);
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: directory })).toThrow(/regular file/i);
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: target })).toThrow(/link/i);
    });

    it('rejects readable-by-others, writable-by-others, executable, and oversized files', () => {
        for (const mode of [0o640, 0o604, 0o660, 0o602, 0o700]) {
            const secretPath = createSecretFile(secret, mode);
            expect(
                () => loadBootSecret({ IDLE_MASTER_SECRET_FILE: secretPath }),
                `expected mode ${mode.toString(8)} to be rejected`,
            ).toThrow(/permissions/i);
        }

        const oversized = createSecretFile(`${secret}\nextra`);
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: oversized })).toThrow(/content/i);
        const crlf = createSecretFile(`${secret}\r\n`);
        expect(() => loadBootSecret({ IDLE_MASTER_SECRET_FILE: crlf })).toThrow(/content/i);
    });

    it('rejects malformed file content without exposing the path or content', () => {
        const invalidPath = createSecretFile('z'.repeat(64));
        let thrown: unknown;
        try {
            loadBootSecret({ IDLE_MASTER_SECRET_FILE: invalidPath });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toMatch(/content/i);
        expect(message).not.toContain(invalidPath);
        expect(message).not.toContain('z'.repeat(64));
    });

    it('consumes and erases both source keys on success and failure', () => {
        const directEnvironment = {
            IDLE_MASTER_SECRET: secret,
            IDLE_MASTER_SECRET_FILE: undefined,
        };
        expect(consumeBootSecret(directEnvironment)).toBe(secret);
        expect(directEnvironment).not.toHaveProperty('IDLE_MASTER_SECRET');
        expect(directEnvironment).not.toHaveProperty('IDLE_MASTER_SECRET_FILE');

        const invalidEnvironment = {
            IDLE_MASTER_SECRET: 'not-a-valid-secret',
            IDLE_MASTER_SECRET_FILE: undefined,
        };
        expect(() => consumeBootSecret(invalidEnvironment)).toThrow(/64 hexadecimal/i);
        expect(invalidEnvironment).not.toHaveProperty('IDLE_MASTER_SECRET');
        expect(invalidEnvironment).not.toHaveProperty('IDLE_MASTER_SECRET_FILE');
    });
});
