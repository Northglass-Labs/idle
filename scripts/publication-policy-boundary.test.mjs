import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanText } from './opsec-boundary.mjs';
import {
  encryptPublicationPolicyForTest,
  loadPublicationPolicy,
  PublicationPolicyError,
} from './publication-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');

function syntheticPolicy(privatePhrase = 'synthetic private identity') {
  return {
    opsec: {
      normalized: [digest(privatePhrase), digest(privatePhrase.replaceAll(' ', ''))],
      caseSensitive: [],
    },
    upstream: {
      forbidden: [digest('synthetic upstream identity')],
    },
  };
}

test('a correct key authenticates a synthetic exact-match policy and clears its environment source', () => {
  const key = randomBytes(32).toString('hex');
  const encryptedPolicy = encryptPublicationPolicyForTest(syntheticPolicy(), key);
  const env = { IDLE_PUBLICATION_POLICY_KEY: key };

  const policy = loadPublicationPolicy({ encryptedPolicy, env });

  assert.equal(Object.hasOwn(env, 'IDLE_PUBLICATION_POLICY_KEY'), false);
  assert.deepEqual(
    scanText('Synthetic Private Identity', 'fixture.txt', policy.opsec),
    [{ kind: 'prohibited-identity', path: 'fixture.txt' }],
  );
  assert.equal(policy.upstream.forbidden.has(digest('synthetic upstream identity')), true);
});

test('a wrong or malformed provided key fails closed generically after clearing the environment', () => {
  const key = randomBytes(32).toString('hex');
  const encryptedPolicy = encryptPublicationPolicyForTest(syntheticPolicy(), key);

  for (const provided of [randomBytes(32).toString('hex'), 'not-a-policy-key']) {
    const env = { IDLE_PUBLICATION_POLICY_KEY: provided };
    assert.throws(
      () => loadPublicationPolicy({ encryptedPolicy, env }),
      error => (
        error instanceof PublicationPolicyError &&
        error.message === 'Private publication policy could not be authenticated'
      ),
    );
    assert.equal(Object.hasOwn(env, 'IDLE_PUBLICATION_POLICY_KEY'), false);
  }
});

test('scanner entrypoints suppress wrong-key details and fail closed', () => {
  const wrongKey = '0'.repeat(64);
  for (const relativePath of ['scripts/opsec-boundary.mjs', 'scripts/check-upstream-cruft.mjs']) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, relativePath)], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, IDLE_PUBLICATION_POLICY_KEY: wrongKey },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(output, new RegExp(wrongKey));
    assert.doesNotMatch(output, /Unsupported state|auth(?:entication)? tag|decrypt|decipher/i);
  }
});

test('a missing key skips exact private fingerprints while generic PII checks remain active', () => {
  const env = {};
  assert.equal(loadPublicationPolicy({ encryptedPolicy: {}, env }), null);
  assert.equal(Object.hasOwn(env, 'IDLE_PUBLICATION_POLICY_KEY'), false);

  const findings = scanText(
    `Contact ${['public.fixture', 'gmail.com'].join('@')}`,
    'fixture.txt',
    { normalized: new Set(), caseSensitive: new Set() },
  );
  assert.deepEqual(findings, [{ kind: 'gmail-address', path: 'fixture.txt' }]);
});

test('required private-policy mode rejects a missing key without revealing policy details', () => {
  assert.throws(
    () => loadPublicationPolicy({ encryptedPolicy: {}, env: {}, required: true }),
    error => (
      error instanceof PublicationPolicyError &&
      error.message === 'Private publication policy could not be authenticated'
    ),
  );

  const env = { ...process.env };
  delete env.IDLE_PUBLICATION_POLICY_KEY;
  for (const relativePath of ['scripts/opsec-boundary.mjs', 'scripts/check-upstream-cruft.mjs']) {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, relativePath),
      '--require-private-policy',
    ], { cwd: repoRoot, encoding: 'utf8', env });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /path|fingerprint|digest|identity/i);
  }
});

test('public scanner source contains ciphertext, not legacy plaintext digest tables', () => {
  const scannerSources = [
    read('scripts/opsec-boundary.mjs'),
    read('scripts/check-upstream-cruft.mjs'),
  ].join('\n');
  const encryptedPolicy = JSON.parse(read('scripts/publication-policy.encrypted.json'));

  assert.doesNotMatch(scannerSources, /\bDEFAULT_FINGERPRINTS\b|\bFORBIDDEN_FINGERPRINTS\s*=\s*new Set/);
  assert.equal(scannerSources.match(/['"][a-f0-9]{64}['"]/g)?.length ?? 0, 0);
  assert.deepEqual(Object.keys(encryptedPolicy).sort(), ['algorithm', 'sealed', 'version']);
  assert.equal(encryptedPolicy.version, 1);
  assert.equal(encryptedPolicy.algorithm, 'aes-256-gcm');
  assert.match(encryptedPolicy.sealed, /^[A-Za-z0-9+/]+={0,2}$/);
});

test('the macOS helper uses native Keychain APIs and has no raw-key output mode', () => {
  const helper = read('scripts/publication-policy-keychain.swift');

  assert.match(helper, /import Security/);
  assert.match(helper, /SecRandomCopyBytes/);
  assert.match(helper, /SecItemAdd/);
  assert.match(helper, /SecItemUpdate/);
  assert.match(helper, /kSecClassGenericPassword/);
  assert.match(helper, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(helper, /maxPolicyBytes\s*=\s*64\s*\*\s*1024/);
  assert.match(helper, /read\(upToCount:/);
  assert.doesNotMatch(helper, /readDataToEndOfFile|readToEnd\s*\(/);
  assert.doesNotMatch(helper, /ProcessInfo\.processInfo\.environment/);
  assert.match(helper, /minimalEnvironment/);
  assert.doesNotMatch(helper, /try process\.run\(\)[\s\S]{0,100}process\.environment\s*=/);
  assert.doesNotMatch(helper, /check-docs-hygiene|\/bin\/bash/);
  assert.match(helper, /opsec-boundary\.mjs/);
  assert.match(helper, /check-upstream-cruft\.mjs/);
  assert.match(helper, /process\.arguments\s*=\s*\[script\.path, "--require-private-policy"\]/);
  assert.match(helper, /trusted main or a reviewed release candidate/);
  assert.doesNotMatch(helper, /write\(Data\(encodedKey\.utf8\)\)/);
  assert.match(helper, /keyBytes\.resetBytes/);
  assert.match(helper, /privatePublicationEnvironment\s*=\s*"private-publication-review"/);
  assert.match(helper, /setGitHubEnvironmentSecret\(key: key\)/);
  assert.match(helper, /"secret", "set", environmentName[\s\S]{0,160}"--env", privatePublicationEnvironment/);
  assert.equal(helper.match(/"secret", "set", environmentName/g)?.length, 1);
  assert.doesNotMatch(helper, /setGitHubSecret|environment:\s*nil/);
  assert.doesNotMatch(helper, /find-generic-password|-w\b|export[-_ ]?key|print\s*\(\s*key/i);
  assert.doesNotMatch(helper, /IDLE_PUBLICATION_POLICY_KEY[^\n]*(?:standardOutput|stdout)/);
});

test('private-match diagnostics expose only category counts, never paths or identity digests', () => {
  const upstream = read('scripts/check-upstream-cruft.mjs');

  assert.match(upstream, /known-upstream-identity[^\n]+affected file\(s\)/);
  assert.doesNotMatch(upstream, /<redacted-path:\$\{digest\(issue\.path\)/);
  assert.match(upstream, /unsafePath[\s\S]{0,300}['"]<redacted-path>['"]/);
});
