import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const metadataChunks = new Set(['eXIf', 'iTXt', 'tEXt', 'tIME', 'zTXt']);
const expectedMediaCounts = { '.ico': 1, '.jpg': 1, '.png': 548, '.ttf': 8 };
const expectedNonPngMedia = [
  'packages/idle-app/public/favicon-active.ico',
  'packages/idle-app/sources/assets/fonts/BricolageGrotesque-Bold.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexMono-Italic.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexMono-Regular.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexMono-SemiBold.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexSans-Italic.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexSans-Regular.ttf',
  'packages/idle-app/sources/assets/fonts/IBMPlexSans-SemiBold.ttf',
  'packages/idle-app/sources/assets/fonts/SpaceMono-Regular.ttf',
  'packages/idle-server/sources/storage/__testdata__/image.jpg',
];
const retiredAssetPaths = [
  'packages/idle-app/sources/assets/images/favicon-active.png',
  'packages/idle-app/sources/assets/images/icon-tauri.png',
  'packages/idle-app/sources/assets/images/icon-voice.png',
  'packages/idle-app/sources/assets/images/icon-voice@2x.png',
  'packages/idle-app/sources/assets/images/icon-voice@3x.png',
  'packages/idle-app/sources/assets/images/logo-black.png',
  'packages/idle-app/sources/assets/images/logo-white.png',
  'packages/idle-app/sources/assets/images/logotype-dark.png',
  'packages/idle-app/sources/assets/images/logotype-dark@2x.png',
  'packages/idle-app/sources/assets/images/logotype-dark@3x.png',
  'packages/idle-app/sources/assets/images/logotype-light.png',
  'packages/idle-app/sources/assets/images/logotype-light@2x.png',
  'packages/idle-app/sources/assets/images/logotype-light@3x.png',
  'packages/idle-app/sources/assets/images/logotype.png',
  'packages/idle-app/sources/assets/images/logotype@2x.png',
  'packages/idle-app/sources/assets/images/logotype@3x.png',
  'packages/idle-app/sources/assets/images/screenshots/login-dark.png',
  'packages/idle-app/sources/assets/images/screenshots/login-light.png',
  'packages/idle-app/sources/assets/images/splash-icon.png',
  'packages/idle-app/sources/assets/images/transparent.png',
];

function publishableFiles() {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
  }).toString('utf8')
    .split('\0')
    .filter(file => file && fs.existsSync(path.join(repoRoot, file)));
}

function publishableMedia() {
  return publishableFiles()
    .filter(file => /\.(?:ico|jpe?g|jfif|otf|png|ttf|woff2?)$/i.test(file))
    .sort();
}

function publishablePngs() {
  return publishableMedia().filter(file => file.toLowerCase().endsWith('.png'));
}

function chunkTypes(file) {
  const contents = fs.readFileSync(path.join(repoRoot, file));
  assert.equal(contents.subarray(0, 8).equals(pngSignature), true, `${file} is not a valid PNG`);

  const types = [];
  let offset = 8;
  while (offset + 12 <= contents.length) {
    const length = contents.readUInt32BE(offset);
    const type = contents.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + 12 + length <= contents.length, `${file} has a truncated ${type} chunk`);
    types.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  assert.equal(types.at(-1), 'IEND', `${file} has no terminal IEND chunk`);
  return types;
}

function jpegMetadataMarkers(file) {
  const contents = fs.readFileSync(path.join(repoRoot, file));
  assert.equal(contents.readUInt16BE(0), 0xffd8, `${file} is not a JPEG`);
  const violations = [];
  let offset = 2;

  while (offset + 4 <= contents.length) {
    while (offset < contents.length && contents[offset] === 0xff) offset += 1;
    const marker = contents[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = contents.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= contents.length, `${file} has a truncated JPEG segment`);
    if (marker === 0xe1) violations.push(`${file}:APP1-EXIF-XMP`);
    if (marker === 0xed) violations.push(`${file}:APP13-IPTC-path`);
    if (marker === 0xfe) violations.push(`${file}:comment`);
    offset += length;
  }

  return violations;
}

function decodeOpenTypeName(platformId, bytes) {
  if (platformId !== 0 && platformId !== 3) return bytes.toString('latin1');
  assert.equal(bytes.length % 2, 0);
  const littleEndian = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 2) {
    littleEndian[index] = bytes[index + 1];
    littleEndian[index + 1] = bytes[index];
  }
  return littleEndian.toString('utf16le');
}

function openTypeNames(file) {
  const contents = fs.readFileSync(path.join(repoRoot, file));
  const tableCount = contents.readUInt16BE(4);
  let nameOffset = null;
  let nameLength = null;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    if (contents.toString('ascii', recordOffset, recordOffset + 4) !== 'name') continue;
    nameOffset = contents.readUInt32BE(recordOffset + 8);
    nameLength = contents.readUInt32BE(recordOffset + 12);
    break;
  }
  assert.notEqual(nameOffset, null, `${file} has no OpenType name table`);
  assert.ok(nameOffset + nameLength <= contents.length, `${file} has a truncated name table`);

  const count = contents.readUInt16BE(nameOffset + 2);
  const storageOffset = contents.readUInt16BE(nameOffset + 4);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const recordOffset = nameOffset + 6 + index * 12;
    const platformId = contents.readUInt16BE(recordOffset);
    const nameId = contents.readUInt16BE(recordOffset + 6);
    const length = contents.readUInt16BE(recordOffset + 8);
    const relativeOffset = contents.readUInt16BE(recordOffset + 10);
    const start = nameOffset + storageOffset + relativeOffset;
    const end = start + length;
    assert.ok(end <= nameOffset + nameLength, `${file} has a truncated name value`);
    names.push({ nameId, value: decodeOpenTypeName(platformId, contents.subarray(start, end)) });
  }
  return names;
}

function validateIco(file) {
  const contents = fs.readFileSync(path.join(repoRoot, file));
  assert.equal(contents.readUInt16LE(0), 0, `${file} has an invalid ICO reserved word`);
  assert.equal(contents.readUInt16LE(2), 1, `${file} is not an ICO image`);
  const count = contents.readUInt16LE(4);
  assert.ok(count > 0, `${file} contains no image entries`);
  let lastByte = 6 + count * 16;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const length = contents.readUInt32LE(entry + 8);
    const offset = contents.readUInt32LE(entry + 12);
    assert.ok(offset >= 6 + count * 16 && offset + length <= contents.length, `${file} has an invalid image entry`);
    lastByte = Math.max(lastByte, offset + length);
  }
  assert.equal(lastByte, contents.length, `${file} contains trailing data outside its icon entries`);
}

test('publishable media inventory includes every live image and font type', () => {
  const media = publishableMedia();
  const counts = {};
  for (const file of media) {
    const extension = path.extname(file).toLowerCase();
    counts[extension] = (counts[extension] ?? 0) + 1;
  }
  assert.deepEqual(Object.fromEntries(Object.entries(counts).sort()), expectedMediaCounts);
  assert.deepEqual(media.filter(file => !file.endsWith('.png')), expectedNonPngMedia);
});

function pngNamesBelow(relativeDirectory) {
  return fs.readdirSync(path.join(repoRoot, relativeDirectory))
    .filter(name => name.endsWith('.png'))
    .sort();
}

function requiredAssetNames(relativeSource, assetDirectory) {
  const source = fs.readFileSync(path.join(repoRoot, relativeSource), 'utf8');
  const escapedDirectory = assetDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`require\\(['\"]@/assets/images/${escapedDirectory}/([^'\"]+\\.png)['\"]\\)`, 'g');
  return [...source.matchAll(pattern)].map(match => match[1]).sort();
}

test('publishable PNG assets contain pixels and color data but no identity-bearing metadata chunks', () => {
  const violations = [];
  for (const file of publishablePngs()) {
    for (const type of chunkTypes(file)) {
      if (metadataChunks.has(type)) violations.push(`${file}:${type}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('publishable JPEG and ICO files contain no creator, location, comment, path, or trailing metadata', () => {
  const jpegViolations = publishableMedia()
    .filter(file => /\.(?:jpe?g|jfif)$/i.test(file))
    .flatMap(jpegMetadataMarkers);
  assert.deepEqual(jpegViolations, []);

  for (const file of publishableMedia().filter(file => file.endsWith('.ico'))) validateIco(file);
});

test('bundled font metadata retains copyright and OFL license attribution', () => {
  const fontFiles = publishableMedia().filter(file => /\.(?:otf|ttf|woff2?)$/i.test(file));
  for (const file of fontFiles) {
    const names = openTypeNames(file);
    assert.ok(names.some(({ nameId, value }) => nameId === 0 && value.trim().length > 0), `${file} has no copyright record`);
    assert.ok(
      names.some(({ nameId, value }) => nameId === 13 && /(?:Open Font License|\bOFL\b)/i.test(value)),
      `${file} has no embedded OFL license record`,
    );
  }
});

test('retired one-off artwork stays out of the published app', () => {
  assert.deepEqual(
    retiredAssetPaths.filter(file => fs.existsSync(path.join(repoRoot, file))),
    [],
  );
});

test('avatar source maps statically require every shipped gradient and brutalist image', () => {
  const gradients = pngNamesBelow('packages/idle-app/sources/assets/images/gradients');
  const requiredGradients = requiredAssetNames(
    'packages/idle-app/sources/components/AvatarGradient.tsx',
    'gradients',
  );
  assert.deepEqual(requiredGradients, gradients);
  assert.equal(gradients.length, 100);

  const brutalist = pngNamesBelow('packages/idle-app/sources/assets/images/brutalist');
  const requiredBrutalist = requiredAssetNames(
    'packages/idle-app/sources/components/AvatarBrutalist.tsx',
    'brutalist',
  );
  assert.deepEqual(requiredBrutalist, brutalist);
  assert.deepEqual(
    Object.fromEntries(['Abstract', 'Bauhaus', 'Brutalism'].map(family => [
      family,
      brutalist.filter(name => name.startsWith(`${family}-`)).length,
    ])),
    { Abstract: 262, Bauhaus: 40, Brutalism: 118 },
  );
});

test('release-critical app artwork matches the reviewed pixel assets', () => {
  const expected = new Map([
    ['packages/idle-app/sources/assets/images/icon-adaptive.png', '3645b02dbb3bb3b902fd66eca44b960fc7c8a3c881e858dba203b03e5ff56744'],
    ['packages/idle-app/sources/assets/images/icon-monochrome.png', 'b78e063349a7b73161d990dba7068790b1a60b8f617dd40d0801adf09aec1ff3'],
    ['packages/idle-app/sources/assets/images/icon-tinted.png', 'b78e063349a7b73161d990dba7068790b1a60b8f617dd40d0801adf09aec1ff3'],
    ['packages/idle-app/sources/assets/images/splash-android-dark.png', 'e5ebfcbf3ae81f06d3f4e4bb4f72b7fbe711b90001030ed4ce4f8c78baa5e290'],
    ['packages/idle-app/sources/assets/images/splash-android-light.png', 'e5ebfcbf3ae81f06d3f4e4bb4f72b7fbe711b90001030ed4ce4f8c78baa5e290'],
  ]);

  for (const [file, digest] of expected) {
    const actual = createHash('sha256')
      .update(fs.readFileSync(path.join(repoRoot, file)))
      .digest('hex');
    assert.equal(actual, digest, `${file} changed without an explicit asset review`);
  }
});
