import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const patchPath = path.join(repoRoot, 'patches', 'patch-packed-runtime-dependencies.cjs');
const { applyPackedRuntimeDependencyPatches } = require(patchPath);

const sandboxZod4DeclarationShim = `type V4Refined<
    T extends z.ZodTypeAny,
    _Output = unknown,
    _Input = unknown,
> = T;

type V4Array<
    T extends z.ZodTypeAny,
    _Cardinality = unknown,
> = z.ZodArray<T>;

type V4Object<
    Shape extends z.ZodRawShape,
    _UnknownKeys = unknown,
    _Catchall = unknown,
    _Output = unknown,
    _Input = unknown,
> = z.ZodObject<Shape>;`;

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

function replaceExactlyOnce(content, from, to, label) {
  assert.equal(
    content.split(from).length - 1,
    1,
    `${label} must contain one reviewed source pattern`,
  );
  return content.replace(from, to);
}

function normalizeReviewedTreeToLegacy(nodeModulesRoot) {
  for (const [packageName, relativePath, nativeV4, legacyV3] of [
    ['@anthropic-ai/sandbox-runtime', 'dist/sandbox/sandbox-config.js', "from 'zod/v4'", "from 'zod/v3'"],
    ['privacy-kit', 'dist/index.mjs', "from 'zod/v4'", "from 'zod/v3'"],
    ['privacy-kit', 'dist/index.cjs', "require('zod/v4')", "require('zod/v3')"],
    ['privacy-kit', 'dist/index.d.mts', "from 'zod/v4'", "from 'zod/v3'"],
    ['privacy-kit', 'dist/index.d.cts', "from 'zod/v4'", "from 'zod/v3'"],
  ]) {
    const target = path.join(packageRoot(nodeModulesRoot, packageName), relativePath);
    const content = fs.readFileSync(target, 'utf8');
    if (content.includes(nativeV4)) {
      fs.writeFileSync(
        target,
        replaceExactlyOnce(content, nativeV4, legacyV3, `${packageName}/${relativePath}`),
      );
    } else {
      assert.equal(
        content.split(legacyV3).length - 1,
        1,
        `${packageName}/${relativePath} must contain the reviewed native-v4 or legacy-v3 import`,
      );
    }
  }

  const declarationPath = path.join(
    packageRoot(nodeModulesRoot, '@anthropic-ai/sandbox-runtime'),
    'dist/sandbox/sandbox-config.d.ts',
  );
  let declaration = fs.readFileSync(declarationPath, 'utf8');
  const nativeHeader = `import { z } from 'zod/v4';\n\n${sandboxZod4DeclarationShim}`;
  if (declaration.includes(nativeHeader)) {
    declaration = replaceExactlyOnce(
      declaration,
      nativeHeader,
      "import { z } from 'zod/v3';",
      '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.d.ts',
    )
      .replaceAll('V4Refined', 'z.ZodEffects')
      .replaceAll('V4Array', 'z.ZodArray')
      .replaceAll('V4Object', 'z.ZodObject');
    fs.writeFileSync(declarationPath, declaration);
  } else {
    assert.equal(
      declaration.split("import { z } from 'zod/v3';").length - 1,
      1,
      'sandbox declaration must contain the reviewed native-v4 shim or legacy-v3 import',
    );
  }
}

function copyReviewedTree({ state = 'upstream' } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-packed-dependency-patch-'));
  const nodeModulesRoot = path.join(scratch, 'node_modules');
  for (const [packageName, sourceNodeModules] of reviewedPackages) {
    const source = packageRoot(path.join(repoRoot, sourceNodeModules), packageName);
    const destination = packageRoot(nodeModulesRoot, packageName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
  normalizeReviewedTreeToLegacy(nodeModulesRoot);
  if (state === 'legacy') {
    return {
      nodeModulesRoot,
      cleanup: () => fs.rmSync(scratch, { recursive: true, force: true }),
    };
  }
  assert.equal(state, 'upstream');
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

function assertNativeZod4Imports(nodeModulesRoot) {
  const reviewedImports = [
    ['@anthropic-ai/sandbox-runtime', 'dist/sandbox/sandbox-config.js'],
    ['@anthropic-ai/sandbox-runtime', 'dist/sandbox/sandbox-config.d.ts'],
    ['privacy-kit', 'dist/index.mjs'],
    ['privacy-kit', 'dist/index.cjs'],
    ['privacy-kit', 'dist/index.d.mts'],
    ['privacy-kit', 'dist/index.d.cts'],
  ];
  for (const [packageName, relativePath] of reviewedImports) {
    const source = fs.readFileSync(
      path.join(packageRoot(nodeModulesRoot, packageName), relativePath),
      'utf8',
    );
    assert.doesNotMatch(source, /['"]zod\/v3['"]/, `${packageName}/${relativePath}`);
    assert.match(source, /['"]zod\/v4['"]/, `${packageName}/${relativePath}`);
  }
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
    assertNativeZod4Imports(fixture.nodeModulesRoot);

    const privacyRoot = packageRoot(fixture.nodeModulesRoot, 'privacy-kit');
    const privacy = readJson(path.join(privacyRoot, 'package.json'));
    assert.equal(privacy.version, '0.0.25');
    assert.equal(privacy.dependencies.zod, '^4.6.6');
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

test('the exact legacy-v3 reviewed bytes migrate to native Zod 4', () => {
  const fixture = copyReviewedTree({ state: 'legacy' });
  try {
    assert.deepEqual(
      applyPackedRuntimeDependencyPatches({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: { log() {} },
      }),
      { packages: 6, files: 6 },
    );
    assertNativeZod4Imports(fixture.nodeModulesRoot);
  } finally {
    fixture.cleanup();
  }
});

test('the reviewed Zod parser rejects oversized constrained arrays before parsing elements', () => {
  const fixture = copyReviewedTree();
  try {
    applyPackedRuntimeDependencyPatches({
      nodeModulesRoots: [fixture.nodeModulesRoot],
      logger: { log() {} },
    });
    const privacySource = fs.readFileSync(
      path.join(packageRoot(fixture.nodeModulesRoot, 'privacy-kit'), 'dist/index.mjs'),
      'utf8',
    );
    const specifier = privacySource.match(/from ['"](zod\/v[34])['"]/)?.[1];
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
  } finally {
    fixture.cleanup();
  }
});

test('sandbox configuration keeps its legitimate security behavior', async () => {
  const sandbox = await import(pathToFileURL(path.join(
    repoRoot,
    'packages/idle-cli/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js',
  )).href);
  const valid = sandbox.SandboxRuntimeConfigSchema.safeParse({
    network: {
      allowedDomains: ['example.com', '*.npmjs.org'],
      deniedDomains: ['blocked.example.com'],
    },
    filesystem: {
      denyRead: ['/private'],
      allowWrite: ['/tmp'],
      denyWrite: ['/.ssh'],
    },
  });
  assert.equal(valid.success, true);
  assert.equal(sandbox.NetworkConfigSchema.safeParse({
    allowedDomains: ['*'],
    deniedDomains: [],
  }).success, false);
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
