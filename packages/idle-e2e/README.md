# Idle browser end-to-end tests

This workspace uses Playwright to exercise browser, HTTP API, and CLI flows
against an explicitly selected Idle relay. The suite creates and removes test
account data; run it only against a disposable environment you control.

## Run

Node.js 22.12 or newer and Yarn Classic 1.22 are required. Start a disposable
relay with parallel test-account registration enabled, and start the Idle web
app on `http://localhost:8081`. The relay should use these test-only settings:

```bash
IDLE_ACCOUNT_REGISTRATION_MODE=open
IDLE_MAX_ACCOUNTS=100
```

Do not use those registration settings for a production relay. Start the web
client with the same explicit relay origin and clear Metro's cache whenever
the target changes:

```bash
CI=1 \
APP_ENV=development \
EXPO_PUBLIC_IDLE_SERVER_URL=http://127.0.0.1:3005 \
yarn workspace idle-app expo start --web --clear
```

Then run from the repository root:

```bash
TEST_SERVER_URL=http://127.0.0.1:3005 \
IDLE_ALLOW_LIVE_TESTS=1 \
yarn workspace idle-e2e test
```

Both environment variables are required so an ordinary test command cannot
silently target a live service. `TEST_SERVER_URL` must be a credential-free
HTTP(S) origin. Never put a bearer token or other credential in that URL.
Browser tests also block HTTP and WebSocket traffic outside the configured web
origin and `TEST_SERVER_URL`, including accidental production-relay traffic.

For an interactive browser, use `yarn workspace idle-e2e test:headed`; for the
Playwright debugger, use `yarn workspace idle-e2e test:debug`.

## Coverage

The suite covers challenge-response authentication, terminal pairing, session
and machine behavior, and browser navigation in desktop Chromium and a mobile
Safari profile. Native-device behavior belongs in the
[mobile end-to-end workspace](../idle-e2e-mobile/README.md).
