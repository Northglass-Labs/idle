import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const livePatchPath = path.join(repoRoot, 'patches/force-elevenlabs-livekit-v0.cjs');
const shikiOpsecPatchPath = path.join(repoRoot, 'patches/sanitize-shiki-hack-opsec.cjs');
const urlPolyfillOpsecPatchPath = path.join(
  repoRoot,
  'patches/sanitize-react-native-url-polyfill-opsec.cjs',
);
const skiaReanimatedOpsecPatchPath = path.join(
  repoRoot,
  'patches/sanitize-skia-reanimated-metadata-opsec.cjs',
);
const retiredPatchPaths = [
  'patches/expose-pierre-diffs-style.cjs',
  'patches/fix-livekit-room-reuse.cjs',
  'patches/fix-pierre-trees-preact-hooks.cjs',
  'patches/force-preact-cjs.cjs',
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function resolveAppPackageRoot(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`, {
    paths: [path.join(repoRoot, 'packages/idle-app')],
  }));
}

function loadLivePatch() {
  assert.equal(fs.existsSync(livePatchPath), true, 'the reviewed ElevenLabs patch must exist');
  return require(livePatchPath);
}

function loadShikiOpsecPatch() {
  assert.equal(fs.existsSync(shikiOpsecPatchPath), true, 'the reviewed Shiki OPSEC patch must exist');
  return require(shikiOpsecPatchPath);
}

function loadUrlPolyfillOpsecPatch() {
  assert.equal(
    fs.existsSync(urlPolyfillOpsecPatchPath),
    true,
    'the reviewed URL polyfill OPSEC patch must exist',
  );
  return require(urlPolyfillOpsecPatchPath);
}

function loadSkiaReanimatedOpsecPatch() {
  assert.equal(
    fs.existsSync(skiaReanimatedOpsecPatchPath),
    true,
    'the reviewed Skia/Reanimated OPSEC patch must exist',
  );
  return require(skiaReanimatedOpsecPatchPath);
}

function silentLogger() {
  return { log() {} };
}

function makeFixture({ version = '0.5.8', driftEntry, missingEntry, escapedEntry } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-dependency-patch-'));
  const nodeModulesRoot = path.join(root, 'node_modules');
  const packageRoot = path.join(nodeModulesRoot, '@elevenlabs', 'react-native');
  const entries = {
    main: './dist/lib.js',
    module: './dist/lib.module.js',
    unpkg: './dist/lib.umd.js',
    import: './dist/lib.modern.js',
  };
  if (escapedEntry) entries.main = '../../../outside.js';

  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'src/components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.js'), 'outside sentinel', 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@elevenlabs/react-native',
    version,
    main: entries.main,
    module: entries.module,
    unpkg: entries.unpkg,
    source: 'src/index.ts',
    exports: {
      '.': {
        types: './dist/index.d.ts',
        import: entries.import,
        require: './dist/lib.js',
      },
    },
  }, null, 2)}\n`, 'utf8');

  const bundleAnchor = 'const room={options:{adaptiveStream:{pixelDensity:"screen"}}};';
  for (const [entryName, relativePath] of Object.entries(entries)) {
    if (escapedEntry && entryName === 'main') continue;
    if (missingEntry === entryName) continue;
    fs.writeFileSync(
      path.join(packageRoot, relativePath),
      driftEntry === entryName ? 'const room={options:{adaptiveStream:true}};' : bundleAnchor,
      'utf8',
    );
  }
  fs.writeFileSync(
    path.join(packageRoot, 'src/components/LiveKitRoomWrapper.tsx'),
    driftEntry === 'source'
      ? "const options = { adaptiveStream: true };\n"
      : "const options = {\n        adaptiveStream: { pixelDensity: 'screen' },\n      };\n",
    'utf8',
  );

  return {
    root,
    nodeModulesRoot,
    packageRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('postinstall exposes reviewed dependency transforms and no obsolete Pierre/Preact shims', () => {
  const postinstall = read('scripts/postinstall.cjs');
  const webDockerfile = read('Dockerfile.webapp');
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  const cliPackage = JSON.parse(read('packages/idle-cli/package.json'));
  const metro = read('packages/idle-app/metro.config.js');
  const livePatch = read('patches/force-elevenlabs-livekit-v0.cjs');

  assert.equal(fs.existsSync(livePatchPath), true);
  assert.equal(fs.existsSync(shikiOpsecPatchPath), true);
  assert.equal(fs.existsSync(urlPolyfillOpsecPatchPath), true);
  assert.equal(fs.existsSync(skiaReanimatedOpsecPatchPath), true);
  for (const relativePath of retiredPatchPaths) {
    assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), false, `${relativePath} must stay retired`);
    const retiredBasename = relativePath.split('/').at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(postinstall, new RegExp(retiredBasename));
    assert.doesNotMatch(webDockerfile, new RegExp(retiredBasename));
  }
  assert.match(postinstall, /force-elevenlabs-livekit-v0/);
  assert.match(postinstall, /sanitize-shiki-hack-opsec/);
  assert.match(postinstall, /sanitize-react-native-url-polyfill-opsec/);
  assert.match(postinstall, /sanitize-skia-reanimated-metadata-opsec/);
  assert.match(
    postinstall,
    /yarn workspace idle-app run patch-package --error-on-fail/,
    'the root install must apply native app patches because EAS runs only the root postinstall',
  );
  assert.match(
    appPackage.scripts.postinstall,
    /patch-package --error-on-fail/,
    'native patch drift must make local and EAS installs fail closed',
  );
  assert.equal(appPackage.dependencies.preact, undefined);
  assert.equal(appPackage.dependencies['@elevenlabs/react-native'], '0.5.8');
  assert.equal(cliPackage.dependencies?.dotenv, undefined);
  assert.equal(cliPackage.devDependencies?.dotenv, undefined);
  assert.doesNotMatch(metro, /\bpreact(?:\/hooks)?\b|preactCjsPath|preactHooksCjsPath/);
  assert.doesNotMatch(livePatch, /earlier version|previous patch|prior patch|revert prior|actively un-?patch/i);
  assert.doesNotMatch(livePatch, /console\.warn|anchor.*skip|skip.*anchor/i);
});

test('installed bundle-facing dependency entries exclude full package metadata imports', () => {
  const urlPolyfillRoot = resolveAppPackageRoot('react-native-url-polyfill');
  const urlPolyfillEntry = fs.readFileSync(path.join(urlPolyfillRoot, 'index.js'), 'utf8');
  assert.doesNotMatch(urlPolyfillEntry, /from ['"]\.\/package\.json['"]/);
  assert.match(urlPolyfillEntry, /const name = ['"]react-native-url-polyfill['"];/);
  assert.match(urlPolyfillEntry, /const version = ['"]1\.3\.0['"];/);

  const skiaRoot = resolveAppPackageRoot('@shopify/react-native-skia');
  const reanimatedRoot = resolveAppPackageRoot('react-native-reanimated');
  const reanimated = JSON.parse(fs.readFileSync(path.join(reanimatedRoot, 'package.json'), 'utf8'));
  assert.equal(reanimated.version, '4.2.3');
  for (const relativePath of [
    'lib/commonjs/external/reanimated/renderHelpers.js',
    'lib/module/external/reanimated/renderHelpers.js',
    'src/external/reanimated/renderHelpers.ts',
  ]) {
    const source = fs.readFileSync(path.join(skiaRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /react-native-reanimated\/package\.json/);
    assert.match(source, /const reanimatedVersion\s*=\s*"4\.2\.3";/);
    assert.match(source, /require\("react-native-reanimated"\);/);
  }
});

test('the iOS screen-orientation dependency imports React before using React Native queue helpers', () => {
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  const orientationPackageRoot = resolveAppPackageRoot('expo-screen-orientation');
  const orientationPackage = JSON.parse(
    fs.readFileSync(path.join(orientationPackageRoot, 'package.json'), 'utf8'),
  );
  const registrySource = fs.readFileSync(
    path.join(orientationPackageRoot, 'ios/ScreenOrientationRegistry.swift'),
    'utf8',
  );
  const [major, minor, patch] = orientationPackage.version.split('.').map(Number);

  assert.equal(appPackage.dependencies['expo-screen-orientation'], '~55.0.18');
  assert.equal(major, 55);
  assert.equal(minor, 0);
  assert.ok(patch >= 18, 'expo-screen-orientation must include the React import compatibility fix');
  assert.ok(
    !registrySource.includes('RCTExecuteOnMainQueue')
      || /^internal import React$|^import React$/m.test(registrySource),
    'React Native queue helpers must be imported explicitly for RN 0.83 / Swift builds',
  );
});

test('the iOS notifications dependency imports React before using shared application helpers', () => {
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  const notificationsPackageRoot = resolveAppPackageRoot('expo-notifications');
  const notificationsPackage = JSON.parse(
    fs.readFileSync(path.join(notificationsPackageRoot, 'package.json'), 'utf8'),
  );
  const badgeSource = fs.readFileSync(
    path.join(
      notificationsPackageRoot,
      'ios/ExpoNotifications/Badge/BadgeModule.swift',
    ),
    'utf8',
  );
  const [major, minor, patch] = notificationsPackage.version.split('.').map(Number);

  assert.equal(appPackage.dependencies['expo-notifications'], '~55.0.25');
  assert.equal(major, 55);
  assert.equal(minor, 0);
  assert.ok(patch >= 25, 'expo-notifications must include the React import compatibility fix');
  assert.ok(
    !badgeSource.includes('RCTSharedApplication')
      || /^internal import React$|^import React$/m.test(badgeSource),
    'React Native shared application helpers must be imported explicitly for RN 0.83 / Swift builds',
  );
});

test('the iOS permission requesters import React before using fatal-error helpers', () => {
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  const requesters = [
    {
      name: 'expo-audio',
      range: '~55.0.16',
      minimumPatch: 16,
      source: 'ios/AudioRecordingRequester.swift',
    },
    {
      name: 'expo-camera',
      range: '~55.0.21',
      minimumPatch: 21,
      source: 'ios/Common/CameraPermissionsRequester.swift',
    },
    {
      name: 'expo-image-picker',
      range: '~55.0.22',
      minimumPatch: 22,
      source: 'ios/ImagePickerPermissionRequesters.swift',
    },
  ];

  for (const requester of requesters) {
    const packageRoot = resolveAppPackageRoot(requester.name);
    const packageMetadata = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    const source = fs.readFileSync(path.join(packageRoot, requester.source), 'utf8');
    const [major, minor, patch] = packageMetadata.version.split('.').map(Number);

    assert.equal(appPackage.dependencies[requester.name], requester.range);
    assert.equal(major, 55);
    assert.equal(minor, 0);
    assert.ok(
      patch >= requester.minimumPatch,
      `${requester.name} must include the React import compatibility fix`,
    );
    assert.ok(
      !/\bRCT(?:Fatal|ErrorWithMessage)\b/.test(source)
        || /^internal import React$|^import React$/m.test(source),
      `${requester.name} must import React before using fatal-error helpers`,
    );
  }
});

test('the iOS modern camera scanner delivers initial barcodes and releases dismissed scanners', () => {
  const cameraRoot = resolveAppPackageRoot('expo-camera');
  const cameraPackage = JSON.parse(
    fs.readFileSync(path.join(cameraRoot, 'package.json'), 'utf8'),
  );
  const delegateSource = fs.readFileSync(
    path.join(cameraRoot, 'ios/Current/VisionScannerDelegate.swift'),
    'utf8',
  );
  const moduleSource = fs.readFileSync(
    path.join(cameraRoot, 'ios/CameraViewModule.swift'),
    'utf8',
  );

  assert.equal(cameraPackage.version, '55.0.21');
  assert.match(
    delegateSource,
    /dataScanner\([^)]*didAdd addedItems:/,
    'VisionKit reports a newly recognized QR through didAdd, not didUpdate',
  );
  assert.match(delegateSource, /dataScanner\([^)]*didUpdate updatedItems:/);
  assert.match(delegateSource, /UIAdaptivePresentationControllerDelegate/);
  assert.match(delegateSource, /presentationControllerDidDismiss/);
  assert.match(moduleSource, /controller\.presentationController\?\.delegate = delegate/);
  assert.match(moduleSource, /func onScannerDismissed\(\)/);
  assert.match(moduleSource, /scannerContext = nil/);
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'packages/idle-app/patches/expo-camera+55.0.21.patch')),
    true,
    'the SDK 55 scanner repair must be applied during root and app installs',
  );
});

test('the Expo DOM bridge resolves to the React-import-compatible SDK 55 patch', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const domPackageRoot = resolveAppPackageRoot('@expo/dom-webview');
  const domPackage = JSON.parse(
    fs.readFileSync(path.join(domPackageRoot, 'package.json'), 'utf8'),
  );
  const domSource = fs.readFileSync(
    path.join(domPackageRoot, 'ios/DomWebView.swift'),
    'utf8',
  );

  assert.equal(rootPackage.resolutions['@expo/dom-webview'], '55.0.6');
  assert.equal(domPackage.version, '55.0.6');
  assert.ok(
    !domSource.includes('RCTConvert')
      || /^internal import React$|^import React$/m.test(domSource),
    'the DOM webview bridge must import React before using RCTConvert',
  );
});

test('Expo Updates resolves the SDK 55 native interface that defines its state context', () => {
  const rootPackage = JSON.parse(read('package.json'));
  const appPackage = JSON.parse(read('packages/idle-app/package.json'));
  const interfaceRoot = resolveAppPackageRoot('expo-updates-interface');
  const interfacePackage = JSON.parse(
    fs.readFileSync(path.join(interfaceRoot, 'package.json'), 'utf8'),
  );
  const interfaceSource = fs.readFileSync(
    path.join(interfaceRoot, 'ios/EXUpdatesInterface/UpdatesInterface.swift'),
    'utf8',
  );

  assert.equal(appPackage.dependencies['expo-updates'], '~55.0.26');
  assert.equal(rootPackage.resolutions['expo-updates-interface'], '55.1.6');
  assert.equal(interfacePackage.version, '55.1.6');
  assert.match(
    interfaceSource,
    /public struct UpdatesNativeInterfaceStateContext\b/,
    'Expo Updates and Expo Updates Interface must expose the same native state contract',
  );
});

test('postinstall rewrites the reviewed Shiki grammar token without retaining the sensitive literal', () => {
  const postinstall = read('scripts/postinstall.cjs');
  const patchSource = read('patches/sanitize-shiki-hack-opsec.cjs');
  const sensitiveSuffix = String.fromCharCode(109, 109, 105, 116);
  const equivalentSuffix = String.fromCharCode(109, 92, 92, 120, 54, 100, 105, 116);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-shiki-opsec-patch-'));
  const nodeModulesRoot = path.join(fixtureRoot, 'node_modules');
  const packageRoot = path.join(nodeModulesRoot, '@shikijs', 'langs');
  const grammarPath = path.join(packageRoot, 'dist', 'hack.mjs');

  try {
    fs.mkdirSync(path.dirname(grammarPath), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: '@shikijs/langs', version: '4.3.0' }, null, 2)}\n`,
      'utf8',
    );
    const words = ['co', 'autoco', 'co', 'co', 'co', 'autoco', 'co', 'co', 'co']
      .map(prefix => `${prefix}${sensitiveSuffix}`);
    fs.writeFileSync(
      grammarPath,
      `export default ${JSON.stringify(`${words.join('|')}|safe`)};\n`,
      'utf8',
    );

    assert.match(postinstall, /applyShikiHackOpsecPatch/);
    assert.equal(patchSource.includes(sensitiveSuffix), false);
    const { applyShikiHackOpsecPatch } = loadShikiOpsecPatch();
    assert.deepEqual(
      applyShikiHackOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 1, replacements: 9 },
    );

    const transformed = fs.readFileSync(grammarPath, 'utf8');
    assert.equal(transformed.includes(sensitiveSuffix), false);
    assert.equal(transformed.split(equivalentSuffix).length - 1, 9);
    const encodedPattern = transformed.match(/^export default (".+");$/m)?.[1];
    assert.ok(encodedPattern);
    const pattern = JSON.parse(encodedPattern);
    const compiled = new RegExp(`^(?:${pattern})$`);
    assert.equal(compiled.test(`co${sensitiveSuffix}`), true);
    assert.equal(compiled.test(`autoco${sensitiveSuffix}`), true);
    assert.equal(compiled.test('safe'), true);

    assert.deepEqual(
      applyShikiHackOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 0, replacements: 0 },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('postinstall keeps URL polyfill attribution metadata out of generated runtime bundles', () => {
  const postinstall = read('scripts/postinstall.cjs');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-url-polyfill-opsec-patch-'));
  const nodeModulesRoot = path.join(fixtureRoot, 'node_modules');
  const packageRoot = path.join(nodeModulesRoot, 'react-native-url-polyfill');
  const entryPath = path.join(packageRoot, 'index.js');
  const at = String.fromCharCode(64);
  const author = `Dependency Author <dependency.author${at}gmail.com>`;

  try {
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: 'react-native-url-polyfill',
        version: '1.3.0',
        main: 'index.js',
        author,
        license: 'MIT',
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      entryPath,
      [
        "import './js/ios10Fix';",
        '',
        "import {polyfillGlobal} from 'react-native/Libraries/Utilities/PolyfillFunctions';",
        '',
        "import {name, version} from './package.json';",
        '',
        "export * from './js/URL';",
        "export * from './js/URLSearchParams';",
        '',
        'export function setupURLPolyfill() {',
        '  global.REACT_NATIVE_URL_POLYFILL = `${name}@${version}`;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    assert.match(postinstall, /applyUrlPolyfillOpsecPatch/);
    const { applyUrlPolyfillOpsecPatch } = loadUrlPolyfillOpsecPatch();
    assert.deepEqual(
      applyUrlPolyfillOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 1 },
    );

    const transformed = fs.readFileSync(entryPath, 'utf8');
    assert.doesNotMatch(transformed, /from ['"]\.\/package\.json['"]/);
    assert.match(transformed, /const name = ['"]react-native-url-polyfill['"];/);
    assert.match(transformed, /const version = ['"]1\.3\.0['"];/);
    assert.equal(transformed.includes(author), false);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).author,
      author,
      'the installed license and attribution metadata must remain intact',
    );

    assert.deepEqual(
      applyUrlPolyfillOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 0 },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('postinstall keeps Reanimated attribution metadata out of Skia runtime bundles', () => {
  const postinstall = read('scripts/postinstall.cjs');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-skia-opsec-patch-'));
  const nodeModulesRoot = path.join(fixtureRoot, 'node_modules');
  const skiaRoot = path.join(nodeModulesRoot, '@shopify', 'react-native-skia');
  const reanimatedRoot = path.join(nodeModulesRoot, 'react-native-reanimated');
  const targets = [
    'lib/module/external/reanimated/renderHelpers.js',
    'lib/commonjs/external/reanimated/renderHelpers.js',
    'src/external/reanimated/renderHelpers.ts',
  ];
  const packageImport = 'require("react-native-reanimated/package.json").version';
  const at = String.fromCharCode(64);
  const author = { name: 'Dependency Author', email: `dependency.author${at}gmail.com` };

  try {
    fs.mkdirSync(skiaRoot, { recursive: true });
    fs.mkdirSync(reanimatedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skiaRoot, 'package.json'),
      `${JSON.stringify({
        name: '@shopify/react-native-skia',
        version: '2.5.3',
        main: 'lib/module/index.js',
        module: 'lib/module/index.js',
        license: 'MIT',
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(reanimatedRoot, 'package.json'),
      `${JSON.stringify({
        name: 'react-native-reanimated',
        version: '4.2.3',
        author,
        license: 'MIT',
      }, null, 2)}\n`,
      'utf8',
    );
    for (const relativePath of targets) {
      const target = path.join(skiaRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        target,
        [
          'export let HAS_REANIMATED_3 = false;',
          'try {',
          `  const reanimatedVersion = ${packageImport};`,
          '  require("react-native-reanimated");',
          '  if (reanimatedVersion >= "3.0.0") HAS_REANIMATED_3 = true;',
          '} catch (e) {}',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    assert.match(postinstall, /applySkiaReanimatedOpsecPatch/);
    const { applySkiaReanimatedOpsecPatch } = loadSkiaReanimatedOpsecPatch();
    assert.deepEqual(
      applySkiaReanimatedOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 3 },
    );

    for (const relativePath of targets) {
      const transformed = fs.readFileSync(path.join(skiaRoot, relativePath), 'utf8');
      assert.equal(transformed.includes(packageImport), false);
      assert.match(transformed, /const reanimatedVersion = "4\.2\.3";/);
      assert.equal(transformed.includes(author.email), false);
    }
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(reanimatedRoot, 'package.json'), 'utf8')).author,
      author,
      'the installed license and attribution metadata must remain intact',
    );
    assert.deepEqual(
      applySkiaReanimatedOpsecPatch({ nodeModulesRoots: [nodeModulesRoot], logger: silentLogger() }),
      { packages: 1, files: 0 },
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('the dependency patch is a no-op when the optional app dependency is absent', () => {
  const { applyElevenLabsLiveKitV0Patch } = loadLivePatch();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-dependency-patch-absent-'));
  try {
    assert.deepEqual(
      applyElevenLabsLiveKitV0Patch({ nodeModulesRoots: [root], logger: silentLogger() }),
      { packages: 0, files: 0 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the dependency patch updates every declared runtime entry and source exactly once', () => {
  const { applyElevenLabsLiveKitV0Patch } = loadLivePatch();
  const fixture = makeFixture();
  try {
    assert.deepEqual(
      applyElevenLabsLiveKitV0Patch({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: silentLogger(),
      }),
      { packages: 1, files: 5 },
    );
    assert.deepEqual(
      applyElevenLabsLiveKitV0Patch({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: silentLogger(),
      }),
      { packages: 1, files: 0 },
    );

    for (const relativePath of [
      'dist/lib.js',
      'dist/lib.module.js',
      'dist/lib.umd.js',
      'dist/lib.modern.js',
    ]) {
      const source = fs.readFileSync(path.join(fixture.packageRoot, relativePath), 'utf8');
      assert.equal(source.match(/singlePeerConnection:false/g)?.length, 1);
    }
    const source = fs.readFileSync(
      path.join(fixture.packageRoot, 'src/components/LiveKitRoomWrapper.tsx'),
      'utf8',
    );
    assert.equal(source.match(/singlePeerConnection: false/g)?.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('unsupported versions and changed or missing anchors fail before any package file is written', () => {
  const { applyElevenLabsLiveKitV0Patch } = loadLivePatch();
  for (const options of [
    { version: '0.6.0' },
    { driftEntry: 'module' },
    { driftEntry: 'source' },
    { missingEntry: 'unpkg' },
    { escapedEntry: true },
  ]) {
    const fixture = makeFixture(options);
    try {
      const before = new Map();
      for (const relativePath of [
        'dist/lib.js',
        'dist/lib.module.js',
        'dist/lib.umd.js',
        'dist/lib.modern.js',
        'src/components/LiveKitRoomWrapper.tsx',
      ]) {
        const absolutePath = path.join(fixture.packageRoot, relativePath);
        if (fs.existsSync(absolutePath)) before.set(relativePath, fs.readFileSync(absolutePath, 'utf8'));
      }
      const outsideBefore = fs.readFileSync(path.join(fixture.root, 'outside.js'), 'utf8');

      assert.throws(() => applyElevenLabsLiveKitV0Patch({
        nodeModulesRoots: [fixture.nodeModulesRoot],
        logger: silentLogger(),
      }));
      for (const [relativePath, contents] of before) {
        assert.equal(fs.readFileSync(path.join(fixture.packageRoot, relativePath), 'utf8'), contents);
      }
      assert.equal(fs.readFileSync(path.join(fixture.root, 'outside.js'), 'utf8'), outsideBefore);
    } finally {
      fixture.cleanup();
    }
  }
});
