/**
 * image-size 2.x accepts byte arrays only, while the Metro versions paired
 * with Expo SDK 55 still pass ordinary image paths. Preserve Metro's existing
 * behavior by reading the selected asset before invoking the patched parser.
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = 'metro';
const SUPPORTED_VERSIONS = new Set(['0.83.5', '0.83.7']);
const TARGET = 'src/Assets.js';
const ORIGINAL = [
  '  const isImageInput = assetInfo.files[0].includes(".zip/")',
  '    ? _fs.default.readFileSync(assetInfo.files[0])',
  '    : assetInfo.files[0];',
].join('\n');
const REPLACEMENT = '  const isImageInput = _fs.default.readFileSync(assetInfo.files[0]);';

const defaultNodeModulesRoots = [
  path.resolve(__dirname, '..', 'node_modules'),
  path.resolve(__dirname, '..', 'packages/idle-app/node_modules'),
];

function patchError(reason) {
  return new Error(`[${PACKAGE_NAME} image-size compatibility patch] ${reason}`);
}

function patchMetroAssetsSource(source) {
  const originalCount = source.split(ORIGINAL).length - 1;
  const replacementCount = source.split(REPLACEMENT).length - 1;
  if (originalCount === 1 && replacementCount === 0) {
    return source.replace(ORIGINAL, REPLACEMENT);
  }
  if (originalCount === 0 && replacementCount === 1) return source;
  throw patchError('reviewed Metro asset-loader anchors do not match');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function installedMetroRoots(nodeModulesRoots) {
  const roots = new Map();
  for (const nodeModulesRoot of nodeModulesRoots) {
    for (const relativePath of [
      'metro',
      '@expo/metro/node_modules/metro',
      'metro-transform-worker/node_modules/metro',
    ]) {
      const candidate = path.join(nodeModulesRoot, relativePath);
      const manifest = path.join(candidate, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const realRoot = fs.realpathSync(candidate);
      roots.set(realRoot, realRoot);
    }
  }
  return [...roots.values()];
}

function planPackage(packageRoot) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw patchError('package manifest is unreadable or invalid');
  }
  if (pkg.name !== PACKAGE_NAME) throw patchError('package identity does not match');
  if (!SUPPORTED_VERSIONS.has(pkg.version)) {
    throw patchError(`unsupported installed version ${String(pkg.version ?? 'unknown')}`);
  }

  const targetPath = path.resolve(packageRoot, TARGET);
  if (!isInside(packageRoot, targetPath) || !fs.existsSync(targetPath)) {
    throw patchError('reviewed Metro asset loader is missing or outside the package');
  }
  const realTarget = fs.realpathSync(targetPath);
  if (!isInside(packageRoot, realTarget) || !fs.statSync(realTarget).isFile()) {
    throw patchError('reviewed Metro asset loader is not a regular package file');
  }

  const source = fs.readFileSync(realTarget, 'utf8');
  const patched = patchMetroAssetsSource(source);
  return { absolutePath: realTarget, changed: patched !== source, source: patched };
}

function applyMetroImageSizeBufferPatch({
  nodeModulesRoots = defaultNodeModulesRoots,
  logger = console,
} = {}) {
  const packageRoots = installedMetroRoots(nodeModulesRoots);
  const plans = packageRoots.map(planPackage);
  const changed = plans.filter((plan) => plan.changed);
  for (const plan of changed) fs.writeFileSync(plan.absolutePath, plan.source, 'utf8');
  if (changed.length > 0) {
    logger.log(`[dependency-patch] applied reviewed Metro image parser compatibility transform to ${changed.length} file(s)`);
  }
  return { packages: packageRoots.length, files: changed.length };
}

module.exports = {
  applyMetroImageSizeBufferPatch,
  patchMetroAssetsSource,
};

if (require.main === module) applyMetroImageSizeBufferPatch();
