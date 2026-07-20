import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyEasArchive } from './verify-eas-archive.mjs';

const requiredFiles = [
  'package.json',
  'yarn.lock',
  'packages/idle-app/package.json',
  'packages/idle-app/app.config.js',
  'packages/idle-app/eas.json',
  'packages/idle-app/certs/certificate.pem',
  'packages/idle-app/certs/public-key.pem',
  'packages/idle-wire/package.json',
];

function write(root, relativePath, contents = 'fixture') {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function makeValidArchive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-eas-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of requiredFiles) write(root, file);
  return root;
}

test('accepts the minimal production archive without native CLI tool payloads', t => {
  const root = makeValidArchive(t);
  assert.deepEqual(verifyEasArchive(root).violations, []);
});

test('accepts empty directory shells left by Git-backed EAS filtering', t => {
  const root = makeValidArchive(t);
  for (const directory of [
    '.github/workflows',
    'docs/deploy-targets',
    'packages/idle-app/native-tests/crypto-harness',
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }

  assert.deepEqual(verifyEasArchive(root).violations, []);
});

test('rejects repository history, local credentials, native tests, and every CLI tool payload', t => {
  const root = makeValidArchive(t);
  for (const file of [
    '.git/config',
    'packages/idle-app/credentials.json',
    'packages/idle-cli/.env.dev',
    '.npmrc',
    'packages/idle-app/.npmrc',
    '.yarnrc',
    'packages/idle-app/.yarnrc.yml',
    '.netrc',
    'packages/idle-app/.pypirc',
    'packages/idle-app/native-tests/harness.ts',
    'packages/idle-cli/tools/unpacked/rg',
    'packages/idle-cli/tools/archives/ripgrep-x64-linux.tar.gz',
  ]) write(root, file);

  const { violations } = verifyEasArchive(root);
  for (const boundary of [
    '.git',
    'packages/idle-app/credentials.json',
    'packages/idle-cli/.env.dev',
    '.npmrc',
    'packages/idle-app/.npmrc',
    '.yarnrc',
    'packages/idle-app/.yarnrc.yml',
    '.netrc',
    'packages/idle-app/.pypirc',
    'packages/idle-app/native-tests',
    'packages/idle-cli/tools',
  ]) {
    assert.ok(violations.some(violation => violation.includes(boundary)), `${boundary} must be rejected`);
  }
});

test('rejects symlinks and archives over the configured size ceiling', t => {
  const root = makeValidArchive(t);
  fs.symlinkSync('package.json', path.join(root, 'linked-package.json'));

  const { violations } = verifyEasArchive(root, { maxTotalBytes: 1 });
  assert.ok(violations.some(violation => violation.includes('linked-package.json')));
  assert.ok(violations.some(violation => violation.includes('size ceiling')));
});
