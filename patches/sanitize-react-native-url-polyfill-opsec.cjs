/**
 * Keep react-native-url-polyfill's package attribution on disk without
 * importing its entire package.json into generated application bundles. The
 * package reads only its public name and version at runtime, so exact constants
 * preserve behavior while excluding unrelated author metadata. The transform
 * is version- and anchor-bound and fails closed on dependency drift.
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = 'react-native-url-polyfill';
const SUPPORTED_VERSION = '1.3.0';
const TARGET = 'index.js';
const IMPORT_ANCHOR = "import {name, version} from './package.json';";
const CONSTANT_REPLACEMENT = [
  `const name = '${PACKAGE_NAME}';`,
  `const version = '${SUPPORTED_VERSION}';`,
].join('\n');
const BEHAVIOR_ANCHOR = 'global.REACT_NATIVE_URL_POLYFILL = `${name}@${version}`;';

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

function installedPackageRoots(nodeModulesRoots) {
  const packages = new Map();
  for (const nodeModulesRoot of nodeModulesRoots) {
    const candidate = path.join(nodeModulesRoot, PACKAGE_NAME);
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
  if (pkg.main !== TARGET) throw patchError('runtime entrypoint does not match');

  const targetPath = path.resolve(packageRoot, TARGET);
  if (!isInside(packageRoot, targetPath) || !fs.existsSync(targetPath)) {
    throw patchError('reviewed runtime target is missing or outside the package');
  }
  const realTarget = fs.realpathSync(targetPath);
  if (!isInside(packageRoot, realTarget) || !fs.statSync(realTarget).isFile()) {
    throw patchError('reviewed runtime target is not a regular package file');
  }

  const source = fs.readFileSync(realTarget, 'utf8');
  if (occurrenceCount(source, BEHAVIOR_ANCHOR) !== 1) {
    throw patchError('public runtime behavior anchor does not match');
  }
  const importCount = occurrenceCount(source, IMPORT_ANCHOR);
  const replacementCount = occurrenceCount(source, CONSTANT_REPLACEMENT);
  if (importCount === 1 && replacementCount === 0) {
    return {
      absolutePath: realTarget,
      changed: true,
      source: source.replace(IMPORT_ANCHOR, CONSTANT_REPLACEMENT),
    };
  }
  if (importCount === 0 && replacementCount === 1) {
    return { absolutePath: realTarget, changed: false, source };
  }
  throw patchError('reviewed runtime anchors do not match the expected transform');
}

function applyUrlPolyfillOpsecPatch({
  nodeModulesRoots = defaultNodeModulesRoots,
  logger = console,
} = {}) {
  const packageRoots = installedPackageRoots(nodeModulesRoots);
  const plans = packageRoots.map(planPackage);
  const changed = plans.filter(plan => plan.changed);

  for (const plan of changed) fs.writeFileSync(plan.absolutePath, plan.source, 'utf8');
  if (changed.length > 0) {
    logger.log(`[dependency-patch] excluded URL polyfill package metadata from ${changed.length} runtime file(s)`);
  }
  return { packages: packageRoots.length, files: changed.length };
}

module.exports = {
  applyUrlPolyfillOpsecPatch,
};

if (require.main === module) applyUrlPolyfillOpsecPatch();
