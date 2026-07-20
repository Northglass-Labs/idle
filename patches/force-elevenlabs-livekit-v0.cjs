/**
 * Force the ElevenLabs React Native client onto LiveKit's compatible RTC
 * negotiation path. The installed package is pinned because this transform
 * relies on reviewed package entrypoints and exact source anchors.
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = '@elevenlabs/react-native';
const SUPPORTED_VERSION = '0.5.8';
const EXPECTED_RUNTIME_ENTRIES = [
  './dist/lib.js',
  './dist/lib.modern.js',
  './dist/lib.module.js',
  './dist/lib.umd.js',
];
const SOURCE_ENTRY = 'src/index.ts';
const SOURCE_TARGET = 'src/components/LiveKitRoomWrapper.tsx';
const BUNDLE_ANCHOR = 'options:{adaptiveStream:{pixelDensity:"screen"}}';
const BUNDLE_REPLACEMENT = 'options:{adaptiveStream:{pixelDensity:"screen"},singlePeerConnection:false}';
const SOURCE_ANCHOR = "adaptiveStream: { pixelDensity: 'screen' },";
const SOURCE_REPLACEMENT = `${SOURCE_ANCHOR}\n        singlePeerConnection: false,`;

const defaultNodeModulesRoots = [
  path.resolve(__dirname, '..', 'node_modules'),
  path.resolve(__dirname, '..', 'packages/idle-app/node_modules'),
];

function patchError(reason) {
  return new Error(`[${PACKAGE_NAME} patch] ${reason}`);
}

function occurrenceCount(source, marker) {
  return source.split(marker).length - 1;
}

function transformAnchoredSource(source, anchor, replacement, label) {
  const anchorCount = occurrenceCount(source, anchor);
  const replacementCount = occurrenceCount(source, replacement);
  const unpatchedAnchorCount = occurrenceCount(source.replaceAll(replacement, ''), anchor);
  if (anchorCount === 1 && replacementCount === 0) {
    return { changed: true, source: source.replace(anchor, replacement) };
  }
  if (replacementCount === 1 && unpatchedAnchorCount === 0) {
    return { changed: false, source };
  }
  throw patchError(`${label} does not match the reviewed transform`);
}

function collectRuntimeEntries(pkg) {
  const entries = new Set();
  for (const field of ['main', 'module', 'unpkg', 'browser']) {
    if (typeof pkg[field] === 'string') entries.add(pkg[field]);
  }

  function collectExport(value, key) {
    if (key === 'types') return;
    if (typeof value === 'string') {
      if (!/\.d\.[cm]?ts$/.test(value)) entries.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [childKey, childValue] of Object.entries(value)) {
      collectExport(childValue, childKey);
    }
  }
  collectExport(pkg.exports?.['.'], '.');
  return [...entries].sort();
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolvePackageFile(packageRoot, relativePath, label) {
  if (!relativePath.startsWith('./') && relativePath !== SOURCE_TARGET) {
    throw patchError(`${label} is not a package-relative path`);
  }
  const absolutePath = path.resolve(packageRoot, relativePath);
  if (!isInside(packageRoot, absolutePath) || !fs.existsSync(absolutePath)) {
    throw patchError(`${label} is missing or outside the package`);
  }
  const realPath = fs.realpathSync(absolutePath);
  if (!isInside(packageRoot, realPath) || !fs.statSync(realPath).isFile()) {
    throw patchError(`${label} is not a regular package file`);
  }
  return realPath;
}

function installedPackageRoots(nodeModulesRoots) {
  const packages = new Map();
  for (const nodeModulesRoot of nodeModulesRoots) {
    const candidate = path.join(nodeModulesRoot, '@elevenlabs', 'react-native');
    const manifest = path.join(candidate, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const realRoot = fs.realpathSync(candidate);
    packages.set(realRoot, realRoot);
  }
  return [...packages.values()];
}

function planPackage(packageRoot) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw patchError('package manifest is unreadable or invalid');
  }
  if (pkg.name !== PACKAGE_NAME) throw patchError('package identity does not match');
  if (pkg.version !== SUPPORTED_VERSION) {
    throw patchError(`unsupported installed version ${String(pkg.version ?? 'unknown')}`);
  }
  if (pkg.source !== SOURCE_ENTRY) throw patchError('source entrypoint does not match the reviewed package');

  const runtimeEntries = collectRuntimeEntries(pkg);
  if (JSON.stringify(runtimeEntries) !== JSON.stringify(EXPECTED_RUNTIME_ENTRIES)) {
    throw patchError('runtime entrypoints do not match the reviewed package');
  }

  const changes = [];
  for (const relativePath of runtimeEntries) {
    const absolutePath = resolvePackageFile(packageRoot, relativePath, `runtime entry ${relativePath}`);
    const current = fs.readFileSync(absolutePath, 'utf8');
    const transformed = transformAnchoredSource(
      current,
      BUNDLE_ANCHOR,
      BUNDLE_REPLACEMENT,
      `runtime entry ${relativePath}`,
    );
    changes.push({ absolutePath, ...transformed });
  }

  const sourcePath = resolvePackageFile(packageRoot, SOURCE_TARGET, 'source target');
  const source = fs.readFileSync(sourcePath, 'utf8');
  changes.push({
    absolutePath: sourcePath,
    ...transformAnchoredSource(source, SOURCE_ANCHOR, SOURCE_REPLACEMENT, 'source target'),
  });
  return changes;
}

function applyElevenLabsLiveKitV0Patch({
  nodeModulesRoots = defaultNodeModulesRoots,
  logger = console,
} = {}) {
  const packageRoots = installedPackageRoots(nodeModulesRoots);
  const plans = packageRoots.flatMap(planPackage);
  const changed = plans.filter(plan => plan.changed);

  for (const plan of changed) fs.writeFileSync(plan.absolutePath, plan.source, 'utf8');
  if (changed.length > 0) {
    logger.log(`[dependency-patch] applied reviewed LiveKit compatibility transform to ${changed.length} file(s)`);
  }
  return { packages: packageRoots.length, files: changed.length };
}

module.exports = {
  applyElevenLabsLiveKitV0Patch,
};

if (require.main === module) applyElevenLabsLiveKitV0Patch();
