import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const patch = () => require('../patches/metro-image-size-v2.cjs').applyMetroImageSizeV2Patch;
const original = {
  'Assets.js': 'const isImageInput = assetInfo.files[0].includes(".zip/")\n    ? _fs.default.readFileSync(assetInfo.files[0])\n    : assetInfo.files[0];\n  const dimensions = isImage ? (0, _imageSize.default)(isImageInput) : null;',
  'Assets.js.flow': "const isImageInput = assetInfo.files[0].includes('.zip/')\n    ? fs.readFileSync(assetInfo.files[0])\n    : assetInfo.files[0];\n  const dimensions = isImage ? getImageSize(isImageInput) : null;",
};
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-metro-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function fixture(nm, version = '0.83.7') {
  const dir = path.join(nm, 'metro');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'metro', version }));
  for (const [name, source] of Object.entries(original)) fs.writeFileSync(path.join(dir, 'src', name), source);
  return dir;
}
test('patch reaches nested Metro versions and is idempotent', t => {
  const nm = path.join(temporary(t), 'node_modules');
  fixture(nm, '0.83.5');
  fixture(path.join(nm, '@expo/metro/node_modules'));
  const options = { nodeModulesRoots: [nm], logger: { log() {} } };
  assert.deepEqual(patch()(options), { packages: 2, files: 4 });
  assert.deepEqual(patch()(options), { packages: 2, files: 0 });
});
test('unsupported nested version fails before writing any package', t => {
  const nm = path.join(temporary(t), 'node_modules');
  const good = fixture(nm);
  fixture(path.join(nm, 'other/node_modules'), '0.84.0');
  assert.throws(() => patch()({ nodeModulesRoots: [nm] }), /unsupported/);
  assert.equal(fs.readFileSync(path.join(good, 'src/Assets.js'), 'utf8'), original['Assets.js']);
});
test('source drift and escaping source links fail closed', t => {
  const base = temporary(t), nm = path.join(base, 'node_modules'), dir = fixture(nm);
  fs.writeFileSync(path.join(dir, 'src/Assets.js.flow'), 'drift');
  assert.throws(() => patch()({ nodeModulesRoots: [nm] }), /anchor/);
  assert.equal(fs.readFileSync(path.join(dir, 'src/Assets.js'), 'utf8'), original['Assets.js']);
  fs.unlinkSync(path.join(dir, 'src/Assets.js.flow'));
  fs.writeFileSync(path.join(base, 'outside'), original['Assets.js.flow']);
  fs.symlinkSync(path.join(base, 'outside'), path.join(dir, 'src/Assets.js.flow'));
  assert.throws(() => patch()({ nodeModulesRoots: [nm] }), /outside/);
});
test('the actual Expo asset path preserves dimensions, scaling, hashes and parser rejection', async t => {
  const { getUniversalAssetData } = require('@expo/metro-config/build/transform-worker/getAssets.js');
  const base = temporary(t), zip = path.join(base, 'fixture.zip');
  fs.mkdirSync(zip);
  const png = fs.readFileSync(path.join(root, 'packages/idle-app/node_modules/expo-router/assets/unmatched.png'));
  const files = [['image.png', png, 436, 266], ['image@2x.png', png, 218, 133],
    ['fixture.zip/image.png', png, 436, 266],
    ['image.gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'), 1, 1],
    ['image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"></svg>'), 7, 9],
    ['plain.txt', Buffer.from('ordinary text'), undefined, undefined]];
  // Keep @2x in a separate family so Metro does not prefer the 1x sibling.
  files[1][0] = 'retina@2x.png';
  for (const [name, bytes, width, height] of files) {
    const file = path.join(base, name); fs.writeFileSync(file, bytes);
    const data = await getUniversalAssetData(file, name, [], 'web', '/assets?export_path=fixtures');
    assert.equal(data.width, width); assert.equal(data.height, height);
    assert.deepEqual(data.fileHashes, [createHash('md5').update(bytes).digest('hex')]);
    assert.match(data.name, /\.[a-f0-9]{32}$/);
  }
  const bad = path.join(base, 'bad.png'); fs.writeFileSync(bad, 'invalid image');
  await assert.rejects(getUniversalAssetData(bad, 'bad.png', [], 'web', '/assets'));
});
