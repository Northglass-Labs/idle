# Idle app

The Idle app is the Expo client for iOS, Android, and the web. It pairs with an
Idle account, displays encrypted coding-agent sessions, sends messages, and
handles supported permission requests.

## Develop

Node.js 22.12 or newer and Yarn Classic 1.22 are required. From the repository
root:

```bash
yarn install --frozen-lockfile
yarn workspace @northglass/idle-wire build
yarn workspace idle-app start
```

Useful package commands:

```bash
yarn workspace idle-app web
yarn workspace idle-app ios:dev
yarn workspace idle-app android:dev
yarn workspace idle-app typecheck
yarn workspace idle-app test --run
```

Use the repository environment manager when developing against a local relay;
see [Contributing](../../docs/CONTRIBUTING.md). Keep signing credentials and
release configuration outside public changes.

Android builds that use Google services must provide `IDLE_GOOGLE_SERVICES_FILE`
as the path to a build-time file. Store that JSON as an EAS file secret or an
equivalent CI-managed file; do not copy it into the repository. Builds that do
not use those services omit the native configuration.

## Security boundary

Native builds store account material in platform secure storage. Browser storage
is accessible to same-origin JavaScript, so a compromised web origin has a
different risk boundary. Session content is encrypted before relay transport,
while routing metadata, optional integrations, push, voice, and service
credentials have documented exceptions.

Authenticated HTTP and attachment transfers reject redirects. Native attachment
PUTs stay on the exact configured relay origin; direct multipart uploads and
downloads are accepted only over HTTPS for the built-in AWS S3, Google Cloud
Storage, Cloudflare R2, Azure Blob, DigitalOcean Spaces, Backblaze B2, and Wasabi
endpoint families. Use relay-local attachment storage when a self-hosted object
store does not have one of those public endpoint names.

Read the [security model](../../docs/SECURITY.md), [privacy notice](PRIVACY.md),
and [encryption reference](../../docs/encryption.md) before changing storage,
pairing, networking, or provider integrations.

## License

MIT. See [LICENSE](LICENSE).
