/**
 * Skia checks the installed Reanimated version at runtime by requiring the
 * dependency's entire package.json. Metro therefore embeds unrelated author
 * metadata in the application bundle. Replace only that version lookup with
 * the exact installed version while preserving the runtime availability check,
 * package manifests, licenses, and attribution on disk.
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = '@shopify/react-native-skia';
const SUPPORTED_VERSION = '2.5.3';
const REANIMATED_PACKAGE = 'react-native-reanimated';
const REANIMATED_VERSION = '4.2.3';
const TARGETS = [
  'lib/commonjs/external/reanimated/renderHelpers.js',
  'lib/module/external/reanimated/renderHelpers.js',
  'src/external/reanimated/renderHelpers.ts',
];
const PACKAGE_IMPORT = 'require("react-native-reanimated/package.json").version';
const VERSION_LITERAL = `"${REANIMATED_VERSION}"`;
const RUNTIME_CHECK = 'require("react-native-reanimated");';

const defaultNodeModulesRoots = [
  path.resolve(__dirname, '..', 'node_modules'),
  path.resolve(__dirname, '..', 'packages/idle-app/node_modules'),
];

function patchError(reason) {
  return new Error(`[${PACKAGE_NAME} OPSEC patch] ${reason}`);
}

function occurrenceCount(source, marker) {
  return source.split(marker).length - 1;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolvePackageFile(packageRoot, relativePath) {
  const absolutePath = path.resolve(packageRoot, relativePath);
  if (!isInside(packageRoot, absolutePath) || !fs.existsSync(absolutePath)) {
    throw patchError(`reviewed runtime target ${relativePath} is missing or outside the package`);
  }
  const realPath = fs.realpathSync(absolutePath);
  if (!isInside(packageRoot, realPath) || !fs.statSync(realPath).isFile()) {
    throw patchError(`reviewed runtime target ${relativePath} is not a regular package file`);
  }
  return realPath;
}

function installedPackageRoots(nodeModulesRoots) {
  const packages = new Map();
  for (const nodeModulesRoot of nodeModulesRoots) {
    const candidate = path.join(nodeModulesRoot, '@shopify', 'react-native-skia');
    const manifest = path.join(candidate, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const realRoot = fs.realpathSync(candidate);
    packages.set(realRoot, realRoot);
  }
  return [...packages.values()];
}

function readManifest(manifestPath, label) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw patchError(`${label} manifest is unreadable or invalid`);
  }
}

function assertPackageVersions(packageRoot) {
  const pkg = readManifest(path.join(packageRoot, 'package.json'), 'Skia');
  if (pkg.name !== PACKAGE_NAME) throw patchError('package identity does not match');
  if (pkg.version !== SUPPORTED_VERSION) {
    throw patchError(`unsupported installed Skia version ${String(pkg.version ?? 'unknown')}`);
  }
  if (pkg.main !== 'lib/module/index.js' || pkg.module !== 'lib/module/index.js') {
    throw patchError('Skia runtime entrypoints do not match the reviewed package');
  }

  let reanimatedManifestPath;
  try {
    reanimatedManifestPath = require.resolve(`${REANIMATED_PACKAGE}/package.json`, {
      paths: [packageRoot],
    });
  } catch {
    throw patchError('Reanimated manifest could not be resolved from Skia');
  }
  const reanimated = readManifest(reanimatedManifestPath, 'Reanimated');
  if (reanimated.name !== REANIMATED_PACKAGE || reanimated.version !== REANIMATED_VERSION) {
    throw patchError('installed Reanimated version does not match the reviewed runtime literal');
  }
}

function planTarget(packageRoot, relativePath) {
  const absolutePath = resolvePackageFile(packageRoot, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  if (occurrenceCount(source, RUNTIME_CHECK) !== 1) {
    throw patchError(`${relativePath} runtime availability anchor does not match`);
  }
  const importCount = occurrenceCount(source, PACKAGE_IMPORT);
  const literalCount = occurrenceCount(source, VERSION_LITERAL);
  if (importCount === 1 && literalCount === 0) {
    return {
      absolutePath,
      changed: true,
      source: source.replace(PACKAGE_IMPORT, VERSION_LITERAL),
    };
  }
  if (importCount === 0 && literalCount === 1) {
    return { absolutePath, changed: false, source };
  }
  throw patchError(`${relativePath} metadata import anchors do not match the expected transform`);
}

function planPackage(packageRoot) {
  assertPackageVersions(packageRoot);
  return TARGETS.map(relativePath => planTarget(packageRoot, relativePath));
}

function applySkiaReanimatedOpsecPatch({
  nodeModulesRoots = defaultNodeModulesRoots,
  logger = console,
} = {}) {
  const packageRoots = installedPackageRoots(nodeModulesRoots);
  const plans = packageRoots.flatMap(planPackage);
  const changed = plans.filter(plan => plan.changed);

  for (const plan of changed) fs.writeFileSync(plan.absolutePath, plan.source, 'utf8');
  if (changed.length > 0) {
    logger.log(`[dependency-patch] excluded Reanimated package metadata from ${changed.length} Skia runtime file(s)`);
  }
  return { packages: packageRoots.length, files: changed.length };
}

module.exports = {
  applySkiaReanimatedOpsecPatch,
};

if (require.main === module) applySkiaReanimatedOpsecPatch();
