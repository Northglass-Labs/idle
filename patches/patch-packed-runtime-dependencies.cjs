#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

const reviewedPackages = [
  {
    name: '@anthropic-ai/sandbox-runtime',
    version: '0.0.37',
    files: [
      {
        relativePath: 'package.json',
        originalSha256: '6bfed960637a93d5fd67cb50143a61d080288e6070da69f9da156945bf235ca0',
        patchedSha256: '62ea89f30afd083172bc1bd2dcbe32485395da5742020ff983a4a5a89eea78c8',
        from: '"zod": "^3.24.1"',
        to: '"zod": "^4.6.6"',
      },
      {
        relativePath: 'dist/sandbox/sandbox-config.js',
        patchedSha256: '6d9fe57dfb2fefa04b7493d92b165798c64f037e759627321df17c281c6d81b4',
        inputs: [
          {
            sha256: '90bb76ee7691d4fc7c96ed20a07fc936eee59893eefa2b1bb1a3719339f0794b',
            replacements: [{ from: "from 'zod'", to: "from 'zod/v4'" }],
          },
          {
            sha256: '7e5f3de871e4a122da479913abe90cb972cde5ce51e38d744003691d082d5192',
            replacements: [{ from: "from 'zod/v3'", to: "from 'zod/v4'" }],
          },
        ],
      },
      {
        relativePath: 'dist/sandbox/sandbox-config.d.ts',
        patchedSha256: 'ee01cf4b3a25637b4d7cdcafb58b371f273f8918ba4fa51144ba568c22c263fa',
        inputs: [
          {
            sha256: 'b5867fcb0d3ee5a0212105fb6f0f4150fc0d278f5538f2226e6b0972dcaec124',
            replacements: [
              { from: 'z.ZodEffects', to: 'V4Refined', occurrences: 7 },
              { from: 'z.ZodArray', to: 'V4Array', occurrences: 19 },
              { from: 'z.ZodObject', to: 'V4Object', occurrences: 12 },
              {
                from: "import { z } from 'zod';",
                to: `import { z } from 'zod/v4';\n\n${sandboxZod4DeclarationShim}`,
              },
            ],
          },
          {
            sha256: 'a63ca906bf98bbb06dee2969f32ae68e73ba5b215dc9038acced336c23bea2f0',
            replacements: [
              { from: 'z.ZodEffects', to: 'V4Refined', occurrences: 7 },
              { from: 'z.ZodArray', to: 'V4Array', occurrences: 19 },
              { from: 'z.ZodObject', to: 'V4Object', occurrences: 12 },
              {
                from: "import { z } from 'zod/v3';",
                to: `import { z } from 'zod/v4';\n\n${sandboxZod4DeclarationShim}`,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'privacy-kit',
    version: '0.0.25',
    files: [
      {
        relativePath: 'package.json',
        originalSha256: '3775b5aee4f0b760a6f37b27419d3f82c9cc1a12cf46976efa3733b08ed0bb9a',
        patchedSha256: '100b458e549e304fb391f20ee51845f7ce7cc80f30a1507df023f0af61a481eb',
        from: '"zod": "3.25.76"',
        to: '"zod": "^4.6.6"',
      },
      {
        relativePath: 'dist/index.mjs',
        patchedSha256: 'b2b842339d9a1908f15e9be06a0fb05f8b1d970ad7737cb9aa8b2e66c0c3455e',
        inputs: [
          {
            sha256: '4c06e6c8db5a2100a53b733fb01590bc85b8f46982b66559d7f71295ed4537dd',
            replacements: [{ from: "from 'zod'", to: "from 'zod/v4'" }],
          },
          {
            sha256: '41e6483c2debc85479f14b7c23b1d0e859b1f986032f4dfd9f42b78c64b8f2c6',
            replacements: [{ from: "from 'zod/v3'", to: "from 'zod/v4'" }],
          },
        ],
      },
      {
        relativePath: 'dist/index.cjs',
        patchedSha256: '095ba3615d7316411009060ca7dc362adf48dc864e82ea230baac0dc5cdeea98',
        inputs: [
          {
            sha256: '9fa6994ff871c4d057e3792f4334133bef76755a1a43c7763ebe37c58c5ffd52',
            replacements: [{ from: "require('zod')", to: "require('zod/v4')" }],
          },
          {
            sha256: 'b67d028a5727f6185f3d8ad8575783e62e04fc589f900ddde75a5f9c4dd4d542',
            replacements: [{ from: "require('zod/v3')", to: "require('zod/v4')" }],
          },
        ],
      },
      {
        relativePath: 'dist/index.d.mts',
        patchedSha256: '78dd8d17be2af0a07596b1d685f5ff9ec85d899427dc355f4c395d191719e227',
        inputs: [
          {
            sha256: '9f8d010bdfa66e57e6335d96ef0e12385764a8589e287676de87467f334c5576',
            replacements: [{ from: "from 'zod'", to: "from 'zod/v4'" }],
          },
          {
            sha256: '616605a7d39090f1cb9984204fe6876ee41c7db7ca8f212f4505f8acc0cc23ce',
            replacements: [{ from: "from 'zod/v3'", to: "from 'zod/v4'" }],
          },
        ],
      },
      {
        relativePath: 'dist/index.d.cts',
        patchedSha256: '78dd8d17be2af0a07596b1d685f5ff9ec85d899427dc355f4c395d191719e227',
        inputs: [
          {
            sha256: '9f8d010bdfa66e57e6335d96ef0e12385764a8589e287676de87467f334c5576',
            replacements: [{ from: "from 'zod'", to: "from 'zod/v4'" }],
          },
          {
            sha256: '616605a7d39090f1cb9984204fe6876ee41c7db7ca8f212f4505f8acc0cc23ce',
            replacements: [{ from: "from 'zod/v3'", to: "from 'zod/v4'" }],
          },
        ],
      },
    ],
  },
  {
    name: 'query-string',
    version: '7.1.3',
    files: [
      {
        relativePath: 'package.json',
        originalSha256: '4e806a521ebf91707fe03761008e20e07413080485aac67f467d079999374512',
        patchedSha256: '1e061b625a53f9661e041946a611ded98b6fb27aff87ac2e6cdec276be942550',
        from: '"decode-uri-component": "^0.2.2"',
        to: '"decode-uri-component": "^0.5.1"',
      },
    ],
    checks: [
      {
        relativePath: 'index.js',
        sha256: 'caa3f2c8b45dfe1e91db22ae10743af68de8d96f26515132bb52485ec0f037fa',
      },
    ],
  },
  {
    name: '@prisma/config',
    version: '6.19.3',
    files: [
      {
        relativePath: 'package.json',
        originalSha256: '778b251b77f9d7a879dd4b476235fe1dc4619d353dba4978ed94b240807a4f63',
        patchedSha256: 'dc9a8ac4e26f9b4e0eec5c0a7e121f1ff3c3af6332764328c360a1c6577c0025',
        from: '"deepmerge-ts": "7.1.5"',
        to: '"deepmerge-ts": "8.0.2"',
      },
    ],
  },
  {
    name: 'minio',
    version: '8.0.7',
    files: [],
    checks: [
      {
        relativePath: 'package.json',
        sha256: '06e434631e49ceb17eb8ad566cf59487733302648d17ccacf1c15d433aa94270',
      },
    ],
  },
  {
    name: 'prisma',
    version: '6.19.3',
    files: [],
    checks: [
      {
        relativePath: 'package.json',
        sha256: '640c40516faa0c333995d0e22cf9e09815c3d7f80ef71ac793283d2c9cac41be',
      },
    ],
  },
];

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

function requireRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function resolveReviewedFile(packageRoot, relativePath) {
  const target = path.resolve(packageRoot, relativePath);
  if (!target.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`${relativePath}: patch target escaped package root`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath}: reviewed target must be a regular file`);
  }
  return { stat, target };
}

function applyPackedRuntimeDependencyPatches({
  nodeModulesRoots,
  packageNames = reviewedPackages.map(reviewedPackage => reviewedPackage.name),
  logger = console,
} = {}) {
  if (!Array.isArray(nodeModulesRoots) || nodeModulesRoots.length === 0) {
    throw new Error('nodeModulesRoots must contain at least one directory');
  }

  const pendingWrites = [];
  let packages = 0;
  const selectedNames = new Set(packageNames);
  const unknownNames = [...selectedNames].filter(
    name => !reviewedPackages.some(reviewedPackage => reviewedPackage.name === name),
  );
  if (unknownNames.length > 0) {
    throw new Error(`unknown reviewed packages: ${unknownNames.join(', ')}`);
  }

  for (const nodeModulesRootInput of nodeModulesRoots) {
    const nodeModulesRoot = path.resolve(nodeModulesRootInput);
    requireRealDirectory(nodeModulesRoot, 'node_modules root');

    for (const reviewedPackage of reviewedPackages) {
      if (!selectedNames.has(reviewedPackage.name)) continue;
      const packageRoot = path.resolve(
        nodeModulesRoot,
        ...reviewedPackage.name.split('/'),
      );
      if (!packageRoot.startsWith(`${nodeModulesRoot}${path.sep}`)) {
        throw new Error(`${reviewedPackage.name}: package root escaped node_modules`);
      }
      requireRealDirectory(packageRoot, `${reviewedPackage.name} package root`);

      const manifestPath = path.join(packageRoot, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name !== reviewedPackage.name) {
        throw new Error(`${reviewedPackage.name}: unexpected installed package identity`);
      }
      if (manifest.version !== reviewedPackage.version) {
        throw new Error(
          `${reviewedPackage.name}: unsupported installed version ${manifest.version}`,
        );
      }

      for (const check of reviewedPackage.checks ?? []) {
        const { target } = resolveReviewedFile(packageRoot, check.relativePath);
        const digest = sha256(fs.readFileSync(target));
        if (digest !== check.sha256) {
          throw new Error(
            `${reviewedPackage.name}/${check.relativePath}: unreviewed upstream bytes`,
          );
        }
      }

      for (const file of reviewedPackage.files) {
        const { stat, target } = resolveReviewedFile(packageRoot, file.relativePath);
        const content = fs.readFileSync(target);
        const digest = sha256(content);
        if (digest === file.patchedSha256) continue;
        const inputs = file.inputs ?? [{
          sha256: file.originalSha256,
          replacements: [{ from: file.from, to: file.to }],
        }];
        const input = inputs.find(candidate => candidate.sha256 === digest);
        if (!input) {
          throw new Error(
            `${reviewedPackage.name}/${file.relativePath}: unreviewed upstream bytes`,
          );
        }

        let patched = content.toString('utf8');
        for (const replacement of input.replacements) {
          const occurrences = replacement.occurrences ?? 1;
          if (
            countOccurrences(patched, replacement.from) !== occurrences
            || patched.includes(replacement.to)
          ) {
            throw new Error(
              `${reviewedPackage.name}/${file.relativePath}: reviewed source pattern drifted`,
            );
          }
          patched = patched.split(replacement.from).join(replacement.to);
        }
        if (sha256(patched) !== file.patchedSha256) {
          throw new Error(
            `${reviewedPackage.name}/${file.relativePath}: transform produced unexpected bytes`,
          );
        }
        pendingWrites.push({ content: patched, mode: stat.mode, target });
      }
      packages += 1;
    }
  }

  pendingWrites.forEach(({ content, mode, target }, index) => {
    const temporary = `${target}.idle-patch-${process.pid}-${index}.tmp`;
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  });

  logger.log(
    `[packed-dependency-patch] reviewed ${packages} packages; changed ${pendingWrites.length} files`,
  );
  return { packages, files: pendingWrites.length };
}

module.exports = {
  applyPackedRuntimeDependencyPatches,
  reviewedPackages,
};

if (require.main === module) {
  if (process.argv.length < 3 || process.argv.length > 4) {
    console.error('usage: patch-packed-runtime-dependencies.cjs NODE_MODULES_ROOT [cli|server]');
    process.exit(2);
  }
  const profiles = {
    cli: ['@anthropic-ai/sandbox-runtime'],
    server: ['privacy-kit', 'query-string', '@prisma/config', 'minio', 'prisma'],
  };
  const profile = process.argv[3];
  if (profile && !profiles[profile]) {
    throw new Error(`unknown patch profile: ${profile}`);
  }
  applyPackedRuntimeDependencyPatches({
    nodeModulesRoots: [process.argv[2]],
    packageNames: profile ? profiles[profile] : undefined,
  });
}
