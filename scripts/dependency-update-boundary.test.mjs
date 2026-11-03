import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readLockedVersion(packageName) {
  const lock = fs.readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8');
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lock.match(new RegExp(`(?:^|\\n)${escapedName}@[^\\n]+:\\n  version "([0-9.]+)"`));
  assert.ok(match, `${packageName} must be present in yarn.lock`);
  return match[1].split('.').map(Number);
}

function readLockedVersionForSelector(selector) {
  const lock = fs.readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8');
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lock.match(
    new RegExp(`(?:^|\\n)(?:[^\\n]*, )?${escapedSelector}(?:, [^\\n]*)?:\\n  version "([0-9.]+)"`),
  );
  assert.ok(match, `${selector} must be present in yarn.lock`);
  return match[1].split('.').map(Number);
}

function assertVersionAtLeast(actual, minimum, packageName) {
  const width = Math.max(actual.length, minimum.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference > 0) return;
    if (difference < 0) {
      assert.fail(`${packageName} lock version must be at least ${minimum.join('.')}`);
    }
  }
}

test('Dependabot monitors every ecosystem without opening routine version PRs', () => {
  const config = fs.readFileSync(path.join(repoRoot, '.github/dependabot.yml'), 'utf8');
  assert.match(config, /^version:\s*2$/m);
  for (const ecosystem of ['npm', 'docker', 'github-actions']) {
    assert.match(config, new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`));
  }
  const pullRequestLimits = [...config.matchAll(/open-pull-requests-limit:\s*(\d+)/g)]
    .map((match) => Number(match[1]));
  assert.deepEqual(pullRequestLimits, [0, 0, 0]);
  assert.doesNotMatch(config, /target-branch:|assignees:|reviewers:/);
});

test('development tooling stays above known vulnerable transitive versions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.resolutions.flatted, '3.4.2');
  assert.equal(manifest.resolutions['**/eslint/ajv'], '6.14.0');
  assert.equal(manifest.resolutions['**/@eslint/eslintrc/ajv'], '6.14.0');
});

test('dependency policy stays at or above every reviewed advisory fix', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const appManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-app/package.json'), 'utf8'),
  );
  const cliManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-cli/package.json'), 'utf8'),
  );
  const serverManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-server/package.json'), 'utf8'),
  );
  const wireManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/idle-wire/package.json'), 'utf8'),
  );

  assert.equal(manifest.resolutions['@hono/node-server'], '^2.0.5');
  assert.equal(manifest.resolutions['body-parser'], '^2.4.0');
  assertVersionAtLeast(readLockedVersion('body-parser'), [2, 4, 0], 'body-parser');
  assert.equal(manifest.resolutions.dompurify, '^3.4.17');
  assertVersionAtLeast(readLockedVersion('dompurify'), [3, 4, 17], 'dompurify');
  assert.equal(manifest.resolutions['@xmldom/xmldom'], '^0.8.15');
  assert.equal(manifest.resolutions.axios, '^1.20.0');
  assert.equal(manifest.resolutions['baseline-browser-mapping'], '^2.11.0');
  assert.equal(manifest.resolutions.browserslist, '^4.28.7');
  assert.equal(manifest.resolutions['decode-uri-component'], '0.5.1');
  assertVersionAtLeast(
    readLockedVersion('decode-uri-component'),
    [0, 5, 1],
    'decode-uri-component',
  );
  assert.equal(manifest.resolutions['deepmerge-ts'], '8.0.2');
  assertVersionAtLeast(readLockedVersion('deepmerge-ts'), [8, 0, 2], 'deepmerge-ts');
  assert.equal(manifest.resolutions['engine.io'], '^6.6.10');
  assert.equal(manifest.resolutions['fast-uri'], '^3.1.9');
  assert.equal(manifest.resolutions['pino-pretty/fast-copy'], '^4.1.0');
  assertVersionAtLeast(
    readLockedVersionForSelector('fast-copy@^4.1.0'),
    [4, 1, 0],
    'fast-copy',
  );
  assert.equal(manifest.resolutions['fast-xml-parser'], '^5.10.1');
  assert.equal(manifest.resolutions.fastify, '^5.12.6');
  assert.equal(manifest.resolutions['follow-redirects'], '^1.16.1');
  assert.equal(manifest.resolutions.hono, '^4.13.7');
  assert.equal(manifest.resolutions['@fastify/static/glob'], '^14.0.2');
  assertVersionAtLeast(
    readLockedVersionForSelector('glob@^14.0.2'),
    [14, 0, 2],
    'glob',
  );
  assert.equal(manifest.resolutions['image-size'], '^2.0.3');
  assert.equal(manifest.resolutions.mermaid, '11.17.2');
  assert.equal(manifest.resolutions.postcss, '^8.5.18');
  assert.equal(manifest.resolutions['postcss-selector-parser'], '^6.1.3');
  assert.equal(manifest.resolutions['**/privacy-kit/zod'], '^4.6.6');
  assert.equal(manifest.resolutions['**/@anthropic-ai/sandbox-runtime/zod'], '^4.6.6');
  assert.equal(manifest.resolutions['**/@modelcontextprotocol/sdk/zod'], '^4.6.6');
  assertVersionAtLeast(readLockedVersionForSelector('zod@3.25.76'), [4, 6, 6], 'privacy-kit zod');
  assertVersionAtLeast(
    readLockedVersionForSelector('zod@^3.24.1'),
    [4, 6, 6],
    'sandbox-runtime zod',
  );
  assertVersionAtLeast(
    readLockedVersionForSelector('"zod@^3.25 || ^4.0"'),
    [4, 6, 6],
    'MCP SDK zod',
  );
  assert.equal(manifest.resolutions['proxy-addr'], '^2.0.8');
  assertVersionAtLeast(readLockedVersion('proxy-addr'), [2, 0, 8], 'proxy-addr');
  assert.equal(manifest.resolutions.qs, '^6.16.1');
  assertVersionAtLeast(readLockedVersion('qs'), [6, 16, 1], 'qs');
  assert.equal(manifest.resolutions['socket.io-parser'], '^4.2.7');
  assert.equal(manifest.resolutions['shell-quote'], '^1.11.0');
  assertVersionAtLeast(readLockedVersion('shell-quote'), [1, 11, 0], 'shell-quote');
  assert.equal(manifest.resolutions['source-map-js'], '^1.2.2');
  assert.equal(manifest.resolutions['minio/stream-json'], '^3.6.0');
  assertVersionAtLeast(
    readLockedVersionForSelector('stream-json@^3.6.0'),
    [3, 6, 0],
    'stream-json',
  );
  assert.equal(manifest.resolutions.tar, '^7.5.21');
  assert.equal(appManifest.devDependencies.sharp, '^0.35.4');
  assert.equal(appManifest.dependencies.mermaid, '11.17.2');
  assert.equal(appManifest.dependencies.zod, '^4.6.6');
  assert.equal(cliManifest.dependencies.zod, '^4.6.6');
  assert.equal(cliManifest.dependencies['shell-quote'], '^1.11.0');
  assert.equal(cliManifest.dependencies['@modelcontextprotocol/sdk'], '1.32.0');
  assert.equal(cliManifest.dependencies['@anthropic-ai/sandbox-runtime'], '0.0.37');
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8'),
    /"@modelcontextprotocol\/sdk@1\.32\.0":\n  version "1\.32\.[0-9]+"/,
  );
  assert.equal(serverManifest.dependencies['@fastify/static'], '^10.1.2');
  assert.equal(serverManifest.dependencies.axios, '^1.20.0');
  assert.equal(serverManifest.dependencies.fastify, '^5.12.6');
  assert.equal(serverManifest.dependencies.sharp, '^0.35.4');
  assert.equal(serverManifest.dependencies.zod, '^4.6.6');
  assert.equal(serverManifest.devDependencies.tar, '^7.5.21');
  assert.equal(wireManifest.dependencies.zod, '^4.6.6');
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8'),
    /zod@\^4\.6\.6:\n  version "4\.6\.[6-9]"/,
  );
});
