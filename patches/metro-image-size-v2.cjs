// Metro 0.83 still passes filenames to image-size's former synchronous API.
// Keep the patched image-size 2 parser and adapt only Metro's input to bytes.
const fs = require('node:fs');
const path = require('node:path');

const defaultNodeModulesRoots = [
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../packages/idle-app/node_modules'),
];
const transforms = [
  ['src/Assets.js',
    'const isImageInput = assetInfo.files[0].includes(".zip/")\n    ? _fs.default.readFileSync(assetInfo.files[0])\n    : assetInfo.files[0];\n  const dimensions = isImage ? (0, _imageSize.default)(isImageInput) : null;',
    'const dimensions = isImage ? (0, _imageSize.default)(_fs.default.readFileSync(assetInfo.files[0])) : null;'],
  ['src/Assets.js.flow',
    "const isImageInput = assetInfo.files[0].includes('.zip/')\n    ? fs.readFileSync(assetInfo.files[0])\n    : assetInfo.files[0];\n  const dimensions = isImage ? getImageSize(isImageInput) : null;",
    'const dimensions = isImage ? getImageSize(fs.readFileSync(assetInfo.files[0])) : null;'],
];
const fail = reason => new Error(`[Metro image-size patch] ${reason}`);
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function installedMetroRoots(roots) {
  const seen = new Set(), packages = new Set();
  function visit(nm, boundary) {
    if (!fs.existsSync(nm)) return;
    const real = fs.realpathSync(nm);
    if (seen.has(real)) return;
    if (real !== boundary && !inside(boundary, real)) throw fail('nested node_modules is outside its root');
    seen.add(real);
    function inspect(candidate, name) {
      if (!fs.statSync(candidate).isDirectory()) return;
      const realPackage = fs.realpathSync(candidate);
      // Workspace links are covered by the explicit workspace node_modules roots.
      if (!inside(boundary, realPackage)) {
        if (name === 'metro') throw fail('Metro package is outside node_modules');
        return;
      }
      if (name === 'metro') packages.add(realPackage);
      visit(path.join(realPackage, 'node_modules'), boundary);
    }
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const candidate = path.join(real, entry.name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('@')) {
        for (const child of fs.readdirSync(candidate)) inspect(path.join(candidate, child), `${entry.name}/${child}`);
      } else inspect(candidate, entry.name);
    }
  }
  for (const root of roots) if (fs.existsSync(root)) visit(root, fs.realpathSync(root));
  return [...packages];
}
function planPackage(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'metro') throw fail('package identity does not match');
  if (!['0.83.5', '0.83.7'].includes(pkg.version)) throw fail(`unsupported Metro ${pkg.version}`);
  return transforms.map(([file, before, after]) => {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) throw fail(`missing ${file}`);
    const real = fs.realpathSync(target);
    if (!inside(root, real) || !fs.statSync(real).isFile()) throw fail(`target outside package: ${file}`);
    const source = fs.readFileSync(real, 'utf8');
    const oldCount = source.split(before).length - 1, newCount = source.split(after).length - 1;
    if (oldCount === 0 && newCount === 1) return { target: real, changed: false, source };
    if (oldCount !== 1 || newCount !== 0) throw fail(`unexpected source anchor: ${file}`);
    return { target: real, changed: true, source: source.replace(before, after) };
  });
}
function applyMetroImageSizeV2Patch({ nodeModulesRoots = defaultNodeModulesRoots, logger = console } = {}) {
  const packages = installedMetroRoots(nodeModulesRoots);
  const plans = packages.flatMap(planPackage); // Validate every copy before any write.
  const changes = plans.filter(plan => plan.changed);
  for (const plan of changes) fs.writeFileSync(plan.target, plan.source, 'utf8');
  if (changes.length) logger.log(`[dependency-patch] adapted ${packages.length} Metro packages to image-size 2`);
  return { packages: packages.length, files: changes.length };
}
module.exports = { applyMetroImageSizeV2Patch };
if (require.main === module) applyMetroImageSizeV2Patch();
