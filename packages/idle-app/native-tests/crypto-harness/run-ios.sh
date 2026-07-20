#!/usr/bin/env bash

set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDLE_APP_DIR="$(cd "$HARNESS_DIR/../.." && pwd)"
EXPO="$IDLE_APP_DIR/node_modules/.bin/expo"
MAESTRO="${MAESTRO_BIN:-$HOME/.maestro/bin/maestro}"
DEVICE="${IDLE_CRYPTO_SIMULATOR:-}"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/idle-native-crypto-harness.XXXXXX")"

cleanup() {
  if [ "${IDLE_CRYPTO_KEEP_GENERATED:-0}" = "1" ]; then
    echo "debug artifacts retained: $HARNESS_DIR/ios $HARNESS_DIR/.expo $TEMP_ROOT" >&2
    return
  fi
  if [ -n "${DEVICE:-}" ]; then
    xcrun simctl uninstall "$DEVICE" com.northglass.idle.crypto-harness >/dev/null 2>&1 || true
  fi
  rm -rf "$HARNESS_DIR/ios" "$HARNESS_DIR/.expo" "$TEMP_ROOT"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-][0-9A-F-]*\)) (Booted).*/\1/p' | head -n 1)"
fi
if [ -z "$DEVICE" ]; then
  echo 'error: boot an iOS simulator before running the native crypto harness' >&2
  exit 1
fi
if [ ! -x "$EXPO" ]; then
  echo 'error: install repository dependencies before running the native crypto harness' >&2
  exit 1
fi
if [ ! -x "$MAESTRO" ]; then
  echo 'error: Maestro is required to assert the native harness result' >&2
  exit 1
fi

cd "$HARNESS_DIR"
"$EXPO" prebuild --clean --platform ios --no-install
(
  cd ios
  pod install
)
NODE_ENV=production xcodebuild \
  -workspace ios/IdleNativeCryptoHarness.xcworkspace \
  -scheme IdleNativeCryptoHarness \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "id=$DEVICE" \
  -derivedDataPath "$TEMP_ROOT/DerivedData" \
  ONLY_ACTIVE_ARCH=YES \
  build

APP_PATH="$TEMP_ROOT/DerivedData/Build/Products/Release-iphonesimulator/IdleNativeCryptoHarness.app"
if [ ! -d "$APP_PATH" ]; then
  echo 'error: native crypto harness app was not produced' >&2
  exit 1
fi
xcrun simctl install "$DEVICE" "$APP_PATH"
xcrun simctl launch "$DEVICE" com.northglass.idle.crypto-harness >/dev/null
"$MAESTRO" test \
  --udid "$DEVICE" \
  --debug-output "$TEMP_ROOT/maestro-debug" \
  --test-output-dir "$TEMP_ROOT/maestro-tests" \
  "$HARNESS_DIR/native-crypto-harness.yaml"
