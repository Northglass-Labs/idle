import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const idleAppRoot = path.resolve(harnessRoot, '../..');
const routerRoot = path.join(idleAppRoot, 'sources', 'app');
const productionEntry = fs.readFileSync(path.join(idleAppRoot, 'index.ts'), 'utf8');
const harnessEntry = fs.readFileSync(path.join(harnessRoot, 'index.tsx'), 'utf8');
const harnessCases = fs.readFileSync(path.join(harnessRoot, 'cases.ts'), 'utf8');
const metroConfig = fs.readFileSync(path.join(harnessRoot, 'metro.config.js'), 'utf8');
const runScript = fs.readFileSync(path.join(harnessRoot, 'run-ios.sh'), 'utf8');
const appConfig = require('./app.config.js').expo;
const packageConfig = require('./package.json');

assert.equal(path.relative(routerRoot, harnessRoot).startsWith('..'), true, 'harness entered the Expo Router root');
assert.equal(productionEntry.includes('native-tests'), false, 'production entry imports the native harness');
assert.equal(appConfig.ios.bundleIdentifier, 'com.northglass.idle.crypto-harness');
assert.equal(appConfig.updates.enabled, false, 'test harness updates must remain disabled');
assert.equal(JSON.stringify(appConfig.plugins).includes('expo-router'), false, 'test harness must not enable Expo Router');
assert.deepEqual(
  packageConfig.expo.autolinking.exclude,
  ['@expo/dom-webview'],
  'unused Expo DOM WebView must stay out of the native harness',
);
assert.match(metroConfig, /moduleName === 'react'/, 'harness must deduplicate React');
assert.match(metroConfig, /moduleName === 'react\/jsx-runtime'/, 'harness must deduplicate the JSX runtime');
assert.match(metroConfig, /moduleName === 'react-native'/, 'harness must deduplicate React Native');
assert.match(runScript, /trap cleanup EXIT/, 'runner must clean generated native files on every exit');
assert.match(runScript, /trap 'exit 130' INT/, 'runner must turn interruption into an exiting cleanup path');
assert.match(runScript, /IDLE_CRYPTO_KEEP_GENERATED/, 'debug artifact retention must be explicit');
assert.doesNotMatch(runScript, /expo run:ios/, 'runner must use an embedded Release bundle without Metro');
assert.match(runScript, /simctl uninstall/, 'runner must remove the standalone simulator app');
assert.match(runScript, /--debug-output "\$TEMP_ROOT\/maestro-debug"/, 'Maestro debug logs must stay in temporary storage');
assert.match(runScript, /--test-output-dir "\$TEMP_ROOT\/maestro-tests"/, 'Maestro test artifacts must stay in temporary storage');

assert.match(harnessCases, /from '\.\.\/\.\.\/sources\/encryption\/aes'/, 'harness must import the shipping AES adapter');
assert.match(harnessCases, /from '\.\.\/\.\.\/sources\/sync\/encryption\/encryptor'/, 'harness must import the shipping encryptor');
assert.match(harnessCases, /TurboModuleRegistry\.get<.*>\('Encryption'\)/, 'harness must assert the native rn-encryption module');

const executableSource = `${harnessEntry}\n${harnessCases}`;
for (const forbidden of [
  /crypto\.subtle/,
  /\.web(?:['"]|\.)/,
  /\bfetch\s*\(/,
  /\baxios\b/,
  /https?:\/\//,
  /vi\.mock/,
  /expo-router/,
]) {
  assert.equal(forbidden.test(executableSource), false, `forbidden harness dependency: ${forbidden}`);
}

console.log('native crypto harness isolation: pass');
