/**
 * Preserve the reviewed Hack grammar while preventing a generated bundle from
 * emitting a standalone sensitive vendor token. The replacement is a regular-
 * expression equivalent and the transform fails closed on package drift.
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = '@shikijs/langs';
const SUPPORTED_VERSION = '4.3.0';
const TARGET = 'dist/hack.mjs';
const SENSITIVE_SUFFIX = String.fromCharCode(109, 109, 105, 116);
const EQUIVALENT_SUFFIX = String.fromCharCode(109, 92, 92, 120, 54, 100, 105, 116);
const EXPECTED_OCCURRENCES = 9;

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
    const candidate = path.join(nodeModulesRoot, '@shikijs', 'langs');
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

  const targetPath = path.resolve(packageRoot, TARGET);
  if (!isInside(packageRoot, targetPath) || !fs.existsSync(targetPath)) {
    throw patchError('reviewed grammar target is missing or outside the package');
  }
  const realTarget = fs.realpathSync(targetPath);
  if (!isInside(packageRoot, realTarget) || !fs.statSync(realTarget).isFile()) {
    throw patchError('reviewed grammar target is not a regular package file');
  }

  const source = fs.readFileSync(realTarget, 'utf8');
  const sourceCount = occurrenceCount(source, SENSITIVE_SUFFIX);
  const replacementCount = occurrenceCount(source, EQUIVALENT_SUFFIX);
  if (sourceCount === EXPECTED_OCCURRENCES && replacementCount === 0) {
    return {
      absolutePath: realTarget,
      changed: true,
      replacements: EXPECTED_OCCURRENCES,
      source: source.replaceAll(SENSITIVE_SUFFIX, EQUIVALENT_SUFFIX),
    };
  }
  if (sourceCount === 0 && replacementCount === EXPECTED_OCCURRENCES) {
    return { absolutePath: realTarget, changed: false, replacements: 0, source };
  }
  throw patchError('reviewed grammar anchors do not match the expected transform');
}

function applyShikiHackOpsecPatch({
  nodeModulesRoots = defaultNodeModulesRoots,
  logger = console,
} = {}) {
  const packageRoots = installedPackageRoots(nodeModulesRoots);
  const plans = packageRoots.map(planPackage);
  const changed = plans.filter(plan => plan.changed);

  for (const plan of changed) fs.writeFileSync(plan.absolutePath, plan.source, 'utf8');
  const replacements = changed.reduce((total, plan) => total + plan.replacements, 0);
  if (changed.length > 0) {
    logger.log(`[dependency-patch] applied reviewed Shiki grammar transform to ${changed.length} file(s)`);
  }
  return { packages: packageRoots.length, files: changed.length, replacements };
}

module.exports = {
  applyShikiHackOpsecPatch,
};

if (require.main === module) applyShikiHackOpsecPatch();
