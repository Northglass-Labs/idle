'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const nodeModulesRoot = path.join(serverRoot, 'node_modules');

function manifest(packageName) {
  return JSON.parse(fs.readFileSync(
    path.join(nodeModulesRoot, ...packageName.split('/'), 'package.json'),
    'utf8',
  ));
}

function packageSource(packageName, relativePath) {
  return fs.readFileSync(
    path.join(nodeModulesRoot, ...packageName.split('/'), relativePath),
    'utf8',
  );
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

  // The bundled MinIO runs stream-json 3, so its manifest must ask for it.
  assert.equal(manifest('minio').dependencies['stream-json'], '^3.6.0');
  assert.match(manifest('stream-json').version, /^3\.(?:[6-9]|[1-9][0-9])\.[0-9]+$/);
});

test('every reviewed privacy-kit representation imports native Zod 4', () => {
  for (const relativePath of [
    'dist/index.mjs',
    'dist/index.cjs',
    'dist/index.d.mts',
    'dist/index.d.cts',
  ]) {
    const source = packageSource('privacy-kit', relativePath);
    assert.doesNotMatch(source, /['"]zod\/v3['"]/, relativePath);
    assert.match(source, /['"]zod\/v4['"]/, relativePath);
  }
});

test('privacy-kit uses a Zod parser that rejects oversized constrained arrays first', () => {
  const source = packageSource('privacy-kit', 'dist/index.mjs');
  const specifier = source.match(/from ['"](zod\/v[34])['"]/)?.[1];
  assert.ok(specifier, 'privacy-kit must contain one reviewed Zod entrypoint');
  const z = require(specifier);
  const result = z
    .array(z.string().uuid())
    .max(100)
    .safeParse(Array.from({ length: 5_000 }, () => 0));
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
  assert.deepEqual(result.error.issues[0].path, []);
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

test('privacy-kit CJS request helpers accept native Zod 4 schemas', async () => {
  const privacy = require('privacy-kit');
  const z = require('zod/v4');
  const encoded = await privacy.request.encodeRequest({ title: 'idle-cjs-contract' });
  const decoded = await privacy.request.decodeRequest(
    encoded.data,
    z.object({ title: z.string() }),
  );
  assert.equal(decoded?.body.title, 'idle-cjs-contract');

  const encrypted = await privacy.request.encryptResponse(
    { accepted: true },
    encoded.nonce,
    encoded.publicKey,
  );
  assert.deepEqual(
    await privacy.request.decryptResponse(
      encrypted,
      encoded.nonce,
      encoded.secretKey,
      z.object({ accepted: z.boolean() }),
    ),
    { accepted: true },
  );
});

test('privacy-kit loads its Nitro schemas through native Zod 4', async () => {
  const privacy = await import('privacy-kit');
  const encodedInvalidDocument = Uint8Array.from([
    0x84,
    0x44, 0xa1, 0x01, 0x38, 0x22,
    0xa0,
    0x41, 0x80,
    0x58, 0x60,
    ...Array(96).fill(0),
  ]);
  await assert.rejects(
    privacy.parseNitroEnclaveAttestation(
      Buffer.from(encodedInvalidDocument).toString('base64'),
    ),
    /Invalid attestation/,
  );
});

async function firstBucketNotification(NotificationPoller, record) {
  const { Readable } = require('node:stream');
  const client = {
    region: 'us-east-1',
    makeRequestAsync: async () => Readable.from(
      [Buffer.from(`${JSON.stringify({ Records: [record] })}\n`)],
      { objectMode: false },
    ),
  };
  const poller = new NotificationPoller(client, 'idle-contract', '', '', []);
  return new Promise((resolve, reject) => {
    poller.on('error', reject);
    poller.on('notification', (notification) => {
      poller.stop();
      resolve(notification);
    });
    poller.start();
  });
}

test('MinIO parses bucket notifications through the reviewed stream-json v3 adapter', { timeout: 10_000 }, async () => {
  assert.match(manifest('stream-json').version, /^3\./);
  const record = {
    eventName: 's3:ObjectCreated:Put',
    s3: { bucket: { name: 'idle-contract' }, object: { key: 'sessions/account-1/object.enc' } },
  };

  const commonJs = require('minio');
  assert.deepEqual(await firstBucketNotification(commonJs.NotificationPoller, record), record);

  const esm = await import('minio');
  assert.deepEqual(await firstBucketNotification(esm.NotificationPoller, record), record);
});

test('the packed MinIO transform writes the same bytes as the production image patch', { timeout: 10_000 }, () => {
  const { reviewedPackages } = require(path.join(repoRoot, 'patches', 'patch-packed-runtime-dependencies.cjs'));
  const sourceFiles = reviewedPackages
    .find(reviewedPackage => reviewedPackage.name === 'minio')
    .files.filter(file => file.relativePath.startsWith('dist/'));
  assert.deepEqual(
    sourceFiles.map(file => file.relativePath).sort(),
    ['dist/esm/notification.mjs', 'dist/main/notification.js'],
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-minio-image-patch-'));
  try {
    const imageNodeModules = path.join(scratch, 'node_modules');
    for (const file of sourceFiles) {
      // Rebuild the reviewed upstream bytes from the installed, transformed copy.
      const [input] = file.inputs;
      let upstream = packageSource('minio', file.relativePath);
      for (const replacement of [...input.replacements].reverse()) {
        upstream = upstream.split(replacement.to).join(replacement.from);
      }
      assert.equal(
        crypto.createHash('sha256').update(upstream).digest('hex'),
        input.sha256,
        `${file.relativePath} must reverse to the reviewed upstream bytes`,
      );
      const target = path.join(imageNodeModules, 'minio', file.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, upstream);
    }

    const imagePatch = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'patches', 'patch-minio-stream-json-v3.cjs'), imageNodeModules],
      { encoding: 'utf8' },
    );
    assert.equal(imagePatch.status, 0, imagePatch.stderr);
    for (const file of sourceFiles) {
      assert.equal(
        fs.readFileSync(path.join(imageNodeModules, 'minio', file.relativePath), 'utf8'),
        packageSource('minio', file.relativePath),
        file.relativePath,
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
