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

// Semantic-version precedence, prerelease identifiers included and build
// metadata ignored, so 2.1.6-rc.1 sorts below 2.1.6. Returns <0, 0 or >0.
function compareSemver(left, right) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    assert.ok(match, `unparseable version ${version}`);
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const [x, y] = [a.prerelease[index], b.prerelease[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Evaluates a GitHub advisory range such as ">= 2.0.0, < 2.1.6".
function inAdvisoryRange(version, range) {
  return range.split(',').every((clause) => {
    const match = /^\s*(>=|<=|>|<|=)\s*(\S+)\s*$/.exec(clause);
    assert.ok(match, `unparseable advisory range ${range}`);
    const order = compareSemver(version, match[2]);
    return {
      '>=': order >= 0,
      '>': order > 0,
      '<=': order <= 0,
      '<': order < 0,
      '=': order === 0,
    }[match[1]];
  });
}

function lockedVersionsByPackage() {
  const lock = fs.readFileSync(path.join(repoRoot, 'yarn.lock'), 'utf8');
  const versions = new Map();
  for (const block of lock.split(/\n{2,}/)) {
    const [header, versionLine] = block.split('\n');
    const version = /^ {2}version "([^"]+)"$/.exec(versionLine ?? '')?.[1];
    if (!header || header.startsWith('#') || !version) continue;
    for (const rawSelector of header.replace(/:$/, '').split(', ')) {
      const selector = rawSelector.replace(/^"|"$/g, '');
      const name = selector.slice(0, selector.indexOf('@', selector.startsWith('@') ? 1 : 0));
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(version);
    }
  }
  return versions;
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

  assert.equal(manifest.resolutions['@hono/node-server'], '^2.1.6');
  assert.equal(manifest.resolutions['@humanfs/node'], '^0.16.8');
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
  // Parent-scoped resolutions only reach workspace dependencies through a
  // leading **/, so a bare parent/child key silently leaves the old copy.
  assert.equal(manifest.resolutions['pino-pretty/fast-copy'], undefined);
  assert.equal(manifest.resolutions['fast-copy'], undefined);
  assert.equal(manifest.resolutions['**/pino-pretty/fast-copy'], '^4.1.0');
  assertVersionAtLeast(
    readLockedVersionForSelector('fast-copy@^4.0.0'),
    [4, 1, 0],
    'fast-copy',
  );
  assert.equal(manifest.resolutions['fast-xml-parser'], '^5.12.0');
  assert.equal(manifest.resolutions.fastify, '^5.12.6');
  assert.equal(manifest.resolutions['follow-redirects'], '^1.16.1');
  assert.equal(manifest.resolutions.hono, '^4.13.16');
  // @fastify/static 10.1.9 and later depend on glob ^14 themselves, so the
  // relay needs no glob resolution; only Expo's tooling still asks for 13.
  assert.equal(manifest.resolutions['@fastify/static/glob'], undefined);
  assert.equal(manifest.resolutions['**/@fastify/static/glob'], undefined);
  assertVersionAtLeast(
    readLockedVersionForSelector('"@fastify/static@^10.1.2"'),
    [10, 1, 10],
    '@fastify/static',
  );
  for (const consumer of [
    '@expo/cli',
    '@expo/config',
    '@expo/config-plugins',
    '@expo/fingerprint',
    '@expo/metro-config',
    'expo-updates',
  ]) {
    assert.equal(manifest.resolutions[`**/${consumer}/glob`], '^14.0.2', consumer);
  }
  assertVersionAtLeast(
    readLockedVersionForSelector('glob@^13.0.0'),
    [14, 0, 2],
    'glob',
  );
  assert.equal(manifest.resolutions['**/@expo/fingerprint/minimatch'], '^11.0.1');
  assert.equal(manifest.resolutions['image-size'], '^2.0.3');
  assert.equal(manifest.resolutions['ip-address'], '^10.7.4');
  assert.equal(manifest.resolutions.katex, '^0.18.2');
  assert.equal(manifest.resolutions.mermaid, '11.17.2');
  assert.equal(manifest.resolutions.postcss, '^8.5.18');
  assert.equal(manifest.resolutions['postcss-selector-parser'], '^6.1.5');
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
  assert.equal(manifest.resolutions['minio/stream-json'], undefined);
  assert.equal(manifest.resolutions['stream-json'], undefined);
  assert.equal(manifest.resolutions['**/minio/stream-json'], '^3.6.0');
  assertVersionAtLeast(
    readLockedVersionForSelector('stream-json@^1.8.0'),
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

// Every npm range GitHub lists for the transitive advisories this boundary has
// fixed, as [package, advisory, affected range]. No locked copy may fall in any
// of them, prereleases included.
const LOCKFILE_ADVISORY_RANGES = [
  ['@hono/node-server', 'GHSA-rmxm-3fg6-px4f', '>= 1.19.10, < 2.1.3'],
  ['@hono/node-server', 'GHSA-jpvv-r467-5p4w', '>= 2.0.0, < 2.1.6'],
  ['@hono/node-server', 'GHSA-jpvv-r467-5p4w', '< 1.19.18'],
  ['@hono/node-server', 'GHSA-qv5m-9pm6-hqp3', '>= 2.0.0, < 2.1.6'],
  ['@humanfs/node', 'GHSA-p498-v437-472g', '< 0.16.8'],
  ['fast-copy', 'GHSA-jggr-w7fw-pc2j', '>= 4.0.0, < 4.1.0'],
  ['fast-copy', 'GHSA-jggr-w7fw-pc2j', '>= 3.0.0, < 3.1.0'],
  ['fast-copy', 'GHSA-jggr-w7fw-pc2j', '< 2.2.0'],
  ['fast-xml-parser', 'GHSA-474x-hrwr-fgx4', '<= 5.11.2'],
  ['glob', 'GHSA-3g3m-2fjr-6pw4', '>= 9.0.0, <= 14.0.1'],
  ['hono', 'GHSA-4h7h-rv7c-7m2v', '>= 4.5.1, <= 4.13.15'],
  ['hono', 'GHSA-h7mg-cq63-vhpq', '>= 4.1.4, <= 4.13.15'],
  ['hono', 'GHSA-3gg2-335m-rxc6', '>= 3.12.0, <= 4.13.15'],
  ['hono', 'GHSA-4m76-xfj5-7975', '< 4.13.16'],
  ['hono', 'GHSA-46wx-v44x-9hh2', '< 4.13.16'],
  ['ip-address', 'GHSA-rxp7-6hxx-x8q5', '<= 10.7.3'],
  ['katex', 'GHSA-238p-pmpm-9mq7', '>= 0.11.0, < 0.18.2'],
  ['minimatch', 'GHSA-g3hv-75wg-m249', '>= 7.0.0, < 11.0.1'],
  ['postcss-selector-parser', 'GHSA-rj75-hqrm-r3gf', '>= 7.0.0, < 7.1.6'],
  ['postcss-selector-parser', 'GHSA-rj75-hqrm-r3gf', '< 6.1.5'],
  ['stream-json', 'GHSA-528h-pc64-c93x', '<= 3.4.0'],
  ['stream-json', 'GHSA-mjw6-4jj6-33hc', '< 3.6.0'],
  ['stream-json', 'GHSA-hqr4-qq8f-hg3x', '<= 3.5.0'],
];

test('advisory ranges compare prerelease, boundary, and older-line versions', () => {
  assert.equal(inAdvisoryRange('2.1.6-rc.1', '>= 2.0.0, < 2.1.6'), true);
  assert.equal(inAdvisoryRange('2.1.6', '>= 2.0.0, < 2.1.6'), false);
  assert.equal(inAdvisoryRange('2.0.0-beta.3', '>= 2.0.0, < 2.1.6'), false);
  assert.equal(inAdvisoryRange('1.19.17', '< 1.19.18'), true);
  assert.equal(inAdvisoryRange('4.13.15', '>= 4.5.1, <= 4.13.15'), true);
  assert.equal(inAdvisoryRange('4.13.16-alpha', '< 4.13.16'), true);
  assert.equal(inAdvisoryRange('3.0.4', '>= 3.0.0, < 3.1.0'), true);
  assert.equal(inAdvisoryRange('7.1.5', '>= 7.0.0, < 7.1.6'), true);
  assert.equal(inAdvisoryRange('7.1.6+build.5', '>= 7.0.0, < 7.1.6'), false);
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
  assert.ok(compareSemver('1.0.0-beta.2', '1.0.0-beta.11') < 0);
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0') < 0);
});

test('no locked transitive package falls inside any advisory range', () => {
  const locked = lockedVersionsByPackage();
  assert.ok(locked.size > 500, 'the lockfile parser must see the whole dependency graph');
  assert.ok(locked.get('zod')?.size > 0, 'the lockfile parser must read scoped and quoted selectors');

  const vulnerable = [];
  for (const [name, advisory, range] of LOCKFILE_ADVISORY_RANGES) {
    for (const version of locked.get(name) ?? []) {
      if (inAdvisoryRange(version, range)) vulnerable.push(`${name}@${version} (${advisory})`);
    }
  }
  assert.deepEqual(vulnerable, []);
});
