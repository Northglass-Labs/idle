# Idle mobile end-to-end tests

This package contains Maestro flows for iOS behavior that the web Playwright
suite cannot cover: native navigation, keyboard interactions, foreground and
resume behavior, and simulator rendering.

Repository scripts require Node.js 22.12 or newer and Yarn Classic 1.22.

## Prerequisites

- Xcode with an available iOS Simulator
- Java 21 and the [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro)
- An Idle simulator build installed on the booted simulator

Use an Expo development-simulator build for fast iteration with Metro or a
self-contained preview-simulator build for a reproducible run. Keep signing
credentials and artifact URLs outside the repository.

The development-client helper expects `maestro`, Java 21, Xcode tools, and
`npx` on `PATH`. Set `EXPO_UPDATE_PRIVATE_KEY` to a readable local OTA signing
key when starting Metro; the helper does not source credentials or build
artifacts. Set `IDLE_APP_ID` if the installed simulator bundle differs from the
documented profile default.

## Unauthenticated flows

The smoke and onboarding flows clear application state and do not require an
account:

```bash
yarn test:smoke
yarn test:welcome
```

The development-client helper can start Metro and run the public unauthenticated
flows:

```bash
yarn dev-client:smoke
yarn dev-client:all-public
```

## Authenticated flows

Pair the installed simulator app through Idle's normal QR or manual-link flow
before running authenticated tests. This intentionally exercises the same
authentication boundary used by a real device; the public app contains no test
credential-injection route.

The authenticated wrapper preserves simulator state and verifies that the app
is installed before invoking Maestro:

```bash
yarn test
yarn test:session
yarn test:compose
yarn test:long-press
yarn test:effort
yarn test:think
yarn test:timestamps
yarn test:context
yarn test:links
yarn test:ultrathink
yarn test:connection
yarn test:lab
yarn test:fixes
```

`yarn test` runs the complete authenticated flow inventory in filename order.
The wrapper accepts one or more explicit `flows/*.yaml` paths for a focused
run.

Set `IDLE_APP_ID` when testing a bundle identifier other than the preview
default. The runner selects the only booted iOS simulator. If more than one is
booted, set `IDLE_SIMULATOR_UDID` explicitly; the runner fails closed instead
of allowing Maestro to drive the wrong device. See `scripts/run-authed.sh` for
the small set of supported environment variables.

## Flow inventory

- `00-smoke.yaml`: application launch canary
- `01-auth.yaml`: welcome screen through the real pairing entry point
- `02-open-session.yaml`: open an existing session
- `03-compose-message.yaml`: compose and render a user message
- `04-long-press-menu.yaml`: session action-sheet regression
- `05-effort-picker.yaml`: model effort choices
- `06-think-autocomplete.yaml`: `/think` command suggestions
- `07-timestamp-display.yaml`: timestamp rendering
- `08-context-indicator.yaml`: context-window indicator
- `09-open-links-in-toggle.yaml`: link-opening preference
- `10-ultrathink-strip.yaml`: ultrathink presentation
- `11-connection-status-sheet.yaml`: relay connection details
- `13-lab-subscreen.yaml`: lab settings navigation
- `14-live-codex-session.yaml`: live Codex response, including conditional
  native-sandbox consent
- `15-live-claude-session.yaml`: live Claude response plus a second turn in
  the same provider session
- `16-live-session-relaunch.yaml`: terminate, relaunch, and verify the newest
  Claude transcript retains both turns

## Release-candidate integration pass

The three `test:release:*` commands are intentionally excluded from ordinary
`yarn test`. They create real provider sessions and require an authenticated,
online machine:

Generate a self-contained production-identity simulator app from the exact
reviewed checkout before running the live flows. `APP_ENV=production` is
required during prebuild; omitting it silently generates the development name,
bundle identifier, transport policy, and update channel.

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
export APP_ENV=production
export IDLE_SIMULATOR_UDID="<booted-simulator-udid>"
: "${RUN_ROOT:?set RUN_ROOT to an owner-only directory outside the checkout}"

yarn install --frozen-lockfile
yarn workspace @northglass/idle-wire build
cd packages/idle-app
npx expo prebuild --platform ios --clean
test -d ios/Idle.xcworkspace
xcodebuild \
  -workspace ios/Idle.xcworkspace \
  -scheme Idle \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$IDLE_SIMULATOR_UDID" \
  -derivedDataPath "$RUN_ROOT/DerivedData" \
  ONLY_ACTIVE_ARCH=YES \
  build
```

Install dependencies inside the reviewed checkout before prebuild. Do not
reuse or symlink `node_modules` from another checkout: Metro resolves real
paths during the production bundle phase and the resulting native project is
no longer a self-contained release proof. Build Wire before prebuild so the
native bundle consumes the generated protocol package from the same checkout.

A clean Release build can take 10–15 minutes on an Apple-silicon development
Mac and may be quiet for long stretches. Treat the final `xcodebuild` status
and the verified app metadata as evidence; do not interrupt a quiet build or
substitute a previously generated app.

Keep `RUN_ROOT` owner-only and outside the checkout. Verify the built app is
`com.northglass.idle`, the expected version, runtime `22`, and the `production`
Expo Updates channel before installing it. The private operator runbook records
the complete materialization, pairing, evidence, and cleanup procedure.

Then run the live provider gate from this package:

```bash
export IDLE_MAESTRO_ARTIFACT_ROOT="$RUN_ROOT/Maestro"
IDLE_APP_ID=com.northglass.idle \
IDLE_SIMULATOR_UDID="$IDLE_SIMULATOR_UDID" \
IDLE_RELEASE_LIVE_TEST=1 \
IDLE_MAESTRO_ARTIFACT_ROOT="$IDLE_MAESTRO_ARTIFACT_ROOT" \
IDLE_MAESTRO_INFRA_RETRIES=1 \
yarn test:release
```

The combined command runs Codex, Claude, then the relaunch assertion. Each flow
also remains available separately through `test:release:codex`,
`test:release:claude`, and `test:release:relaunch` while diagnosing a failure.
Every live-flow entry point independently requires `IDLE_RELEASE_LIVE_TEST=1`;
calling the lower-level authenticated runner cannot bypass that guard.
The relaunch flow targets `active-session-row`, which is deliberately distinct
from archived `session-row` history so repeated runs cannot open an older
transcript by accident. The Claude flow sends two prompts through the same
session using the stable `agent-input-send` selector, and the relaunch flow
requires both responses to remain visible. This catches provider adapters that
work for session creation but strand follow-up turns. Review prompts are
cancelled when navigation leaves the sessions route so they cannot interrupt
the new-session release flow.

The runner performs a SpringBoard readiness check, stores Maestro screenshots
and debug output in an owner-only per-run directory, and retries at most once
after a recognized simulator/XCTest infrastructure failure. It never retries
an assertion failure, even when Maestro also reports a teardown error. Set
`IDLE_MAESTRO_INFRA_RETRIES=0` to disable recovery. An explicitly supplied
`IDLE_MAESTRO_ARTIFACT_ROOT` must be absolute; when omitted, the runner creates
a private temporary root and prints its location.

If a provider is unavailable for an external reason, run the three focused
commands separately. A bounded error such as `usage_limit` proves that the
request crossed the app, relay, daemon, and provider adapter, but it does not
count as a successful provider-response gate. Record it as externally blocked,
then independently run Claude and relaunch persistence without weakening the
Codex assertion.

For a release proof, use a disposable simulator account and a separate,
owner-only `IDLE_HOME_DIR` for the CLI. Pair them through the normal protocol,
run the Codex and Claude flows, then run the relaunch flow. Confirm separately
that the CLI credentials and machine registration survive a daemon restart.
Delete the disposable account, stop the isolated daemon, and remove its local
profile when the evidence has been captured.

The simulator proves account creation, signed pairing, post-pair navigation,
remote provider round trips, consent behavior, synchronization, and persisted
relaunch state. It cannot prove physical camera focus, VisionKit callbacks,
haptics, APNs delivery, or TestFlight code signing. Keep one physical-device QR
scan and the short TestFlight checklist as separate release gates.

One-time pairing URLs are credentials. Do not place them in a flow file, shell
history, command argument, screenshot, or test log. Transfer them through an
owner-only ephemeral channel and discard them after use.

## Authoring flows

Use `yarn studio` to inspect the simulator and generate a starting flow. Prefer
stable accessibility or test identifiers over localized copy, keep
`clearState: false` for authenticated scenarios, and avoid embedding account
credentials, local paths, or operator infrastructure in flow files.
