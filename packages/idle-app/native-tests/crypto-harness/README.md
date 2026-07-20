# Native crypto harness

This test-only iOS app exercises Idle's shipping `rn-encryption` AES bridge and
`AES256Encryption` implementation. It is a standalone Expo entrypoint with a
separate bundle identifier. It is outside the Expo Router root, is not imported
by Idle's production entrypoint, has updates disabled, and uses no credentials
or network endpoints.

The harness validates native-module registration, string and byte round trips,
content-based equality, nonce uniqueness, JSON value preservation, framing,
wrong-key rejection, tamper rejection, and empty batches. Headless unit tests
remain useful for fast adapter coverage, but they do not replace this native
boundary check.

## Run on an iOS simulator

Install the repository dependencies, Xcode, CocoaPods, and Maestro. Boot an iOS
simulator, then run:

```sh
cd packages/idle-app/native-tests/crypto-harness
./run-ios.sh
```

The script generates a local native project, embeds a Release bundle without a
Metro endpoint, installs the standalone app under
`com.northglass.idle.crypto-harness`, and asks Maestro to wait for `PASS`.
Generated native projects, simulator app, Maestro output, and temporary build
output are removed on success, failure, or interruption, and are never part of
the Idle app build. For a local build investigation only, set
`IDLE_CRYPTO_KEEP_GENERATED=1` to retain them.

For headless boundary checks and an iOS bundle-only build:

```sh
node ./verify-isolation.mjs
../../node_modules/.bin/tsc --noEmit --project tsconfig.json
../../node_modules/.bin/expo export:embed --platform ios --dev false \
  --entry-file index.tsx --bundle-output /tmp/idle-native-crypto-harness.bundle
```
