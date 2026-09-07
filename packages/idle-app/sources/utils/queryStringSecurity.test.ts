import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('query parsing dependency boundary', () => {
    it('applies the malformed-input guard once and rejects package drift', () => {
        const { applyMalformedUriDecodingPatch } = require('../../../../patches/bound-malformed-uri-decoding.cjs');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-uri-guard-'));
        const nodeModulesRoot = path.join(root, 'node_modules');
        const decoderRoot = path.join(nodeModulesRoot, 'decode-uri-component');
        const entry = path.join(decoderRoot, 'index.js');
        const before = '\t\t// Fallback to a more advanced decoder\n\t\treturn customDecodeURIComponent(encodedURI);';
        const options = { nodeModulesRoots: [nodeModulesRoot], logger: { log() {} } };
        try {
            fs.mkdirSync(decoderRoot, { recursive: true });
            fs.writeFileSync(path.join(decoderRoot, 'package.json'), JSON.stringify({ name: 'decode-uri-component', version: '0.2.2' }));
            fs.writeFileSync(entry, before);
            expect(applyMalformedUriDecodingPatch(options).files).toBe(1);
            expect(applyMalformedUriDecodingPatch(options).files).toBe(0);
            fs.writeFileSync(entry, before);
            fs.writeFileSync(path.join(decoderRoot, 'package.json'), JSON.stringify({ name: 'decode-uri-component', version: '0.3.0' }));
            expect(() => applyMalformedUriDecodingPatch(options)).toThrow('decoder version');
            expect(fs.readFileSync(entry, 'utf8')).toBe(before);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preserves query-string CommonJS decoding behavior', () => {
        const queryString = require('query-string');
        expect(queryString.parse('name=caf%C3%A9+bar&tag=a&tag=b')).toEqual({
            name: 'café bar',
            tag: ['a', 'b'],
        });
        expect(queryString.parse('value=%F0%9F%98%80%ab')).toEqual({ value: '😀%ab' });
        const valid = 'café '.repeat(1024);
        expect(queryString.parse('value=' + encodeURIComponent(valid))).toEqual({ value: valid });
    });

    it('finishes malformed percent decoding without recursive exhaustion', () => {
        // Keep the old decoder's excessive work out of the test runner process.
        const result = spawnSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict');
            const queryString = require(process.argv[1]);
            const malformed = '%C0%AF'.repeat(2048);
            assert.equal(queryString.parse('value=' + malformed).value, malformed);
        `, require.resolve('query-string')], { timeout: 2000, encoding: 'utf8' });
        expect(result.error?.message).toBeUndefined();
        expect(result.status).toBe(0);
    });
});
