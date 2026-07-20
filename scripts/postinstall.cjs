const { execSync } = require('child_process');
const { applyElevenLabsLiveKitV0Patch } = require('../patches/force-elevenlabs-livekit-v0.cjs');
const { applyShikiHackOpsecPatch } = require('../patches/sanitize-shiki-hack-opsec.cjs');
const { applyUrlPolyfillOpsecPatch } = require('../patches/sanitize-react-native-url-polyfill-opsec.cjs');
const { applySkiaReanimatedOpsecPatch } = require('../patches/sanitize-skia-reanimated-metadata-opsec.cjs');

// EAS installs the monorepo from its root and runs only this lifecycle script.
// Apply the app's version-bound patch-package fixes here as well so native
// source fixes are present before Expo prebuilds and compiles CocoaPods.
execSync('yarn workspace idle-app run patch-package --error-on-fail', {
  stdio: 'inherit',
});

applyElevenLabsLiveKitV0Patch();
applyShikiHackOpsecPatch();
applyUrlPolyfillOpsecPatch();
applySkiaReanimatedOpsecPatch();

if (process.env.SKIP_IDLE_WIRE_BUILD === '1') {
  console.log('[postinstall] SKIP_IDLE_WIRE_BUILD=1, skipping @northglass/idle-wire build');
  process.exit(0);
}

execSync('yarn workspace @northglass/idle-wire build', {
  stdio: 'inherit',
});
