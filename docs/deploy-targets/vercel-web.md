# Deploy the Idle web app to Vercel

Vercel can host Idle's static Expo web export. The stateful relay needs a
long-running Socket.IO server and persistent `/data` storage, so deploy it on a
server target first.

## Build configuration

The web bundle reads `EXPO_PUBLIC_IDLE_SERVER_URL` at build time. As the
`EXPO_PUBLIC_` prefix indicates, the value is embedded in JavaScript and is not
a secret. Set it to the public HTTPS URL of your relay; never put credentials,
tokens, or private network names in any `EXPO_PUBLIC_*` variable.

For a Git-connected Vercel project, use:

| Setting | Value |
|---|---|
| Root directory | repository root |
| Install command | `yarn install --frozen-lockfile` |
| Build command | `yarn workspace @northglass/idle-wire build && cd packages/idle-app && APP_ENV=production npx expo export --platform web` |
| Output directory | `packages/idle-app/dist` |

Add `EXPO_PUBLIC_IDLE_SERVER_URL=https://relay.example.com` to each Vercel
environment that should use that relay. Review preview settings separately so a
preview cannot accidentally target production.

## Deploy only the compiled output from a local machine

If you do not want Vercel to receive the repository source, build locally and
deploy the static directory:

```bash
yarn install --frozen-lockfile
yarn workspace @northglass/idle-wire build
cd packages/idle-app
EXPO_PUBLIC_IDLE_SERVER_URL=https://relay.example.com \
  APP_ENV=production npx expo export --platform web
vercel deploy --prod --cwd dist
```

Vercel documents `--cwd` and production deployments in its
[CLI deploy reference](https://vercel.com/docs/cli/deploy). Inspect `dist/`
before uploading it. It should contain compiled public assets only.

## Verify

1. Load the deployment in a private browser window.
2. Confirm the login screen references the intended relay.
3. In browser developer tools, verify the Socket.IO connection goes only to the
   configured HTTPS/WSS origin.
4. Pair a disposable session and send a message in both directions.
5. Check the browser console and network log for mixed content, CORS errors,
   unexpected third-party requests, or source maps containing local paths.

If deep links return `404`, configure a Vercel rewrite to `index.html` and test
both direct navigation and refresh. Do not use a rewrite that proxies arbitrary
paths to the relay.
