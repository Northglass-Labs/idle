import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const patchPath = path.join(repoRoot, 'patches', 'patch-packed-runtime-dependencies.cjs');
const { applyPackedRuntimeDependencyPatches } = require(patchPath);

const reviewedPackages = new Map([
  ['@anthropic-ai/sandbox-runtime', 'packages/idle-cli/node_modules'],
  ['privacy-kit', 'packages/idle-server/node_modules'],
  ['query-string', 'packages/idle-server/node_modules'],
  ['@prisma/config', 'packages/idle-server/node_modules'],
  ['minio', 'packages/idle-server/node_modules'],
  ['prisma', 'packages/idle-server/node_modules'],
]);

function packageRoot(nodeModulesRoot, packageName) {
  return path.join(nodeModulesRoot, ...packageName.split('/'));
}

function copyReviewedTree() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-packed-dependency-patch-'));
  const nodeModulesRoot = path.join(scratch, 'node_modules');
  for (const [packageName, sourceNodeModules] of reviewedPackages) {
    const source = packageRoot(path.join(repoRoot, sourceNodeModules), packageName);
    const destination = packageRoot(nodeModulesRoot, packageName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
  for (const [packageName, relativePath, patched, upstream] of [
    ['@anthropic-ai/sandbox-runtime', 'package.json', '"zod": "^4.6.6"', '"zod": "^3.24.1"'],
    ['@anthropic-ai/sandbox-runtime', 'dist/sandbox/sandbox-config.js', "from 'zod/v3'", "from 'zod'"],
    ['@anthropic-ai/sandbox-runtime', 'dist/sandbox/sandbox-config.d.ts', "from 'zod/v3'", "from 'zod'"],
    ['privacy-kit', 'package.json', '"zod": "^4.6.6"', '"zod": "3.25.76"'],
    ['privacy-kit', 'dist/index.mjs', "from 'zod/v3'", "from 'zod'"],
    ['privacy-kit', 'dist/index.cjs', "require('zod/v3')", "require('zod')"],
    ['privacy-kit', 'dist/index.d.mts', "from 'zod/v3'", "from 'zod'"],
    ['privacy-kit', 'dist/index.d.cts', "from 'zod/v3'", "from 'zod'"],
    ['query-string', 'package.json', '"decode-uri-component": "^0.5.1"', '"decode-uri-component": "^0.2.2"'],
    ['@prisma/config', 'package.json', '"deepmerge-ts": "8.0.2"', '"deepmerge-ts": "7.1.5"'],
  ]) {
    const target = path.join(packageRoot(nodeModulesRoot, packageName), relativePath);
    const content = fs.readFileSync(target, 'utf8');
    assert.equal(
      content.split(patched).length - 1,
      1,
      `${packageName}/${relativePath} must contain one reviewed patched pattern`,
    );
    fs.writeFileSync(target, content.replace(patched, upstream));
  }
  return {
    nodeModulesRoot,
    cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('reviewed packed dependencies receive only the compatibility transforms consumers need', () => {
  const fixture = copyReviewedTree();
  try {
    assert.deepEqual(
      applyPackedRuntimeDependencyPatches({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: { log() {} },
      }),
      { packages: 6, files: 10 },
    );

    const sandbox = readJson(path.join(
      packageRoot(fixture.nodeModulesRoot, '@anthropic-ai/sandbox-runtime'),
      'package.json',
    ));
    assert.equal(sandbox.version, '0.0.37');
    assert.equal(sandbox.dependencies.zod, '^4.6.6');
    assert.match(
      fs.readFileSync(path.join(
        packageRoot(fixture.nodeModulesRoot, '@anthropic-ai/sandbox-runtime'),
        'dist/sandbox/sandbox-config.js',
      ), 'utf8'),
      /from ['"]zod\/v3['"]/,
      'the widened sandbox dependency must keep using upstream Zod 4 compatibility mode',
    );

    const privacyRoot = packageRoot(fixture.nodeModulesRoot, 'privacy-kit');
    const privacy = readJson(path.join(privacyRoot, 'package.json'));
    assert.equal(privacy.version, '0.0.25');
    assert.equal(privacy.dependencies.zod, '^4.6.6');
    for (const relativePath of [
      'dist/index.mjs',
      'dist/index.cjs',
      'dist/index.d.mts',
      'dist/index.d.cts',
    ]) {
      assert.match(
        fs.readFileSync(path.join(privacyRoot, relativePath), 'utf8'),
        /(?:from |require\()['"]zod\/v3['"]\)?/,
        `${relativePath} must use Zod's maintained v3 compatibility export`,
      );
    }

    const queryString = readJson(path.join(
      packageRoot(fixture.nodeModulesRoot, 'query-string'),
      'package.json',
    ));
    assert.equal(queryString.version, '7.1.3');
    assert.equal(queryString.dependencies['decode-uri-component'], '^0.5.1');

    const prismaConfig = readJson(path.join(
      packageRoot(fixture.nodeModulesRoot, '@prisma/config'),
      'package.json',
    ));
    assert.equal(prismaConfig.version, '6.19.3');
    assert.equal(prismaConfig.dependencies['deepmerge-ts'], '8.0.2');

    assert.deepEqual(
      applyPackedRuntimeDependencyPatches({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: { log() {} },
      }),
      { packages: 6, files: 0 },
      'repeated prepack runs must preserve the reviewed bytes',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the packed dependency transform rejects upstream drift before changing bytes', () => {
  const fixture = copyReviewedTree();
  try {
    const target = path.join(
      packageRoot(fixture.nodeModulesRoot, 'privacy-kit'),
      'dist/index.mjs',
    );
    fs.appendFileSync(target, '\n// unreviewed drift\n');

    assert.throws(
      () => applyPackedRuntimeDependencyPatches({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: { log() {} },
      }),
      /privacy-kit\/dist\/index\.mjs: unreviewed upstream bytes/,
    );

    const privacy = readJson(path.join(
      packageRoot(fixture.nodeModulesRoot, 'privacy-kit'),
      'package.json',
    ));
    assert.equal(
      privacy.dependencies.zod,
      '3.25.76',
      'validation must finish before the transform writes any file',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the packed dependency transform rejects unreviewed versions', () => {
  const fixture = copyReviewedTree();
  try {
    const manifestPath = path.join(
      packageRoot(fixture.nodeModulesRoot, 'query-string'),
      'package.json',
    );
    const manifest = readJson(manifestPath);
    manifest.version = '7.1.4';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    assert.throws(
      () => applyPackedRuntimeDependencyPatches({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: { log() {} },
      }),
      /query-string: unsupported installed version 7\.1\.4/,
    );
  } finally {
    fixture.cleanup();
  }
});
