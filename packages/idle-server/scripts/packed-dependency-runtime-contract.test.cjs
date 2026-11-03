'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverRoot = path.resolve(__dirname, '..');
const nodeModulesRoot = path.join(serverRoot, 'node_modules');

function manifest(packageName) {
  return JSON.parse(fs.readFileSync(
    path.join(nodeModulesRoot, ...packageName.split('/'), 'package.json'),
    'utf8',
  ));
}

test('the bundled server graph declares and installs only fixed nested versions', () => {
  assert.equal(manifest('privacy-kit').dependencies.zod, '^4.6.6');
  assert.match(manifest('zod').version, /^4\.6\.[6-9]$/);

  assert.equal(
    manifest('query-string').dependencies['decode-uri-component'],
    '^0.5.1',
  );
  assert.equal(manifest('decode-uri-component').version, '0.5.1');

  assert.equal(manifest('@prisma/config').dependencies['deepmerge-ts'], '8.0.2');
  assert.equal(manifest('deepmerge-ts').version, '8.0.2');
});

test('Idle token, encoding, and encryption paths work through privacy-kit on Zod 4', async () => {
  const privacy = await import('privacy-kit');
  const plaintext = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  assert.deepEqual(privacy.decodeBase64(privacy.encodeBase64(plaintext)), plaintext);

  const master = await privacy.crypto.deriveSecureKey({
    key: 'idle-packed-consumer-contract-secret',
    usage: 'idle-server-tokens',
  });
  const tree = new privacy.KeyTree(master);
  const ciphertext = tree.symmetricEncrypt(['account', 'credential'], 'encrypted-value');
  assert.equal(
    tree.symmetricDecryptString(['account', 'credential'], ciphertext),
    'encrypted-value',
  );

  const generator = await privacy.createPersistentTokenGenerator({
    service: 'idle',
    seed: 'idle-packed-consumer-contract-secret',
  });
  const verifier = await privacy.createPersistentTokenVerifier({
    service: 'idle',
    publicKey: Uint8Array.from(generator.publicKey),
  });
  const token = await generator.new({
    user: 'account-1',
    extras: { authorizationGeneration: 7 },
  });
  const verified = await verifier.verify(token);
  assert.equal(verified?.user, 'account-1');
  assert.deepEqual(verified?.extras, { authorizationGeneration: 7 });
  assert.match(verified?.uuid, /^[a-f0-9-]{36}$/);
});

test('MinIO generates signed S3 object URLs through the fixed query-string graph', async () => {
  const { Client } = require('minio');
  const client = new Client({
    endPoint: 's3.example.test',
    port: 443,
    useSSL: true,
    accessKey: 'contract-access-key',
    secretKey: 'contract-secret-key',
    region: 'us-east-1',
  });

  const url = new URL(await client.presignedGetObject(
    'idle-contract',
    'sessions/account-1/object.enc',
    60,
  ));
  assert.equal(url.origin, 'https://s3.example.test');
  assert.equal(url.pathname, '/idle-contract/sessions/account-1/object.enc');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
});
