# `@northglass/idle-server`

The Idle relay provides authenticated HTTP, Socket.IO synchronization, PGlite
persistence, and local encrypted-attachment storage in one self-hostable Node.js
runtime.

## Install and run

Node.js 22.12 or newer is required.

```bash
npm install -g @northglass/idle-server
(
  cleanup() { stty echo 2>/dev/null || true; unset IDLE_MASTER_SECRET; }
  trap cleanup EXIT
  printf 'Idle master secret (64 hex characters): ' >&2
  stty -echo
  IFS= read -r IDLE_MASTER_SECRET
  stty echo
  printf '\n' >&2
  export IDLE_MASTER_SECRET
  export IDLE_AUTH_AUDIENCE=http://localhost:3005
  idle-server migrate && idle-server serve
)
```

Run migration and serve from the same package installation and data directory.
The subshell reads the secret without echoing it and removes it when the server
stops. For unattended deployments, use the platform secret manager's scoped
file-injection feature and set `IDLE_MASTER_SECRET_FILE` to that absolute runtime
path. Keep the value out of command arguments, Git, images, logs, shell history,
and plaintext environment files. The relay consumes either source at boot,
deletes both source variables from its process environment, and retains the
validated value only in private runtime memory.

From the repository root, the canonical container is:

Use the same non-echoing subshell above, replacing its final command with
`docker compose up -d --build idle-server`. Compose turns the caller's transient
value into a mode-`0400` file mounted only into the relay; the value does not
enter the container environment.

The default runtime uses PGlite at `/data/pglite`, the local filesystem under
`/data/files`, and an in-process event router. Persist `/data` and back it up.
See [Self-hosting](../../docs/SELF-HOSTING.md) for TLS, reverse proxy, and
provider-specific guidance.

## Required and common environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IDLE_MASTER_SECRET` | none | Direct 32-byte secret encoded as exactly 64 hexadecimal characters |
| `IDLE_MASTER_SECRET_FILE` | none | Absolute path to a single-link, owner-only regular file containing the same value and an optional final LF |
| `IDLE_AUTH_AUDIENCE` | required | Exact public relay origin signed into protocol-v3 authentication proofs; HTTPS except for loopback |
| `IDLE_ACCOUNT_REGISTRATION_MODE` | `first-account` | Unknown-key admission mode: `first-account`, `closed`, or explicitly `open` |
| `IDLE_MAX_ACCOUNTS` | `1000` in `open` mode | Durable deployment account ceiling; 1–1,000,000 |
| `IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES` | `10737418240` (10 GiB) | Durable deployment attachment allocation ceiling; positive integer up to 1 PiB |
| `IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS` | `2000` | Durable deployment attachment object ceiling; 1–10,000,000 |
| `PORT` | `3005` | HTTP and Socket.IO listener port |
| `HOST` | `127.0.0.1` outside the container | Listener address |
| `DATA_DIR` | `./data` in the package runtime | Database and local-file base directory |
| `PGLITE_DIR` | `<DATA_DIR>/pglite` | PGlite database directory |
| `PUBLIC_URL` | request origin | Optional clean HTTP(S) origin used for local attachment links; credentials, paths, queries, and fragments are rejected, and raw forwarding headers are ignored |
| `IDLE_CORS_ORIGIN` | none | One additional exact HTTPS browser origin |
| `ELEVENLABS_API_KEY` | none | Optional server-side voice credential |
| `ELEVENLABS_AGENT_ID` | none | Required with server-mediated voice; selects the server-owned agent |
| `ELEVENLABS_MAX_CONVERSATION_SECONDS` | none | Required with server-mediated voice; 1–3600 and exactly equal to the agent's enforced `conversation.max_duration_seconds` |

The source runtime also supports optional external PostgreSQL, Redis, and
S3-compatible storage. Those modes require complete service configuration and
an operator-owned migration and backup plan; the packaged migration command is
the PGlite path.

The default registration policy admits one initial account and then requires
existing credentials or authenticated pairing. A public relay must opt into
`open` registration; its database-backed account ceiling applies across
processes and survives restart.

Direct-auth proofs bind the client's locally selected canonical relay origin to
the server's independent `IDLE_AUTH_AUDIENCE`. The relay does not trust request
host or proxy headers for this identity, and protocol-v2 proofs are rejected.

## Security boundary

Clients encrypt session messages, session and machine metadata/state, account
settings, artifacts, KV values, access keys, RPC values, and attachment bytes
before relay transport.

`IDLE_MASTER_SECRET` is used to issue and verify bearer authentication tokens,
protect any legacy server-readable GitHub OAuth token at rest, and derive a
voice pseudonym. It does not decrypt client-encrypted session content or client
content keys.

The server can decrypt a retained GitHub OAuth token only to revoke it during
authenticated disconnect; new OAuth initiation and callback routes are not
registered. Coding-agent credentials remain local to their provider CLI or SDK.
The relay also sees routing identifiers and metadata, account profile,
usage reports, push tokens, notification title/body, attachment metadata, and
voice integration data. Push title and body are forwarded to the push provider;
do not put transcript content or secrets in them.

Local `GET /files/*` URLs serve only the explicit `public/` image namespace.
Session attachment bytes remain client-encrypted and require authenticated
attachment routes. Uploads use 15-minute durable reservations, exact-size
checks, a 10 MiB per-blob limit, and retained count/byte quotas per session and
account. A shared database ledger also caps allocated attachment bytes and
objects across every account, relay replica, and local/S3 storage mode. It is
backfilled on migration and releases allocation only after safe cancellation or
confirmed object deletion. Expired, unconsumed relay-mediated reservations can
be reaped; issued direct-S3 capabilities remain owned and quota-charged after
expiry so a late object commit cannot become untracked. An exact-size late S3
object can still be confirmed, while a mismatched object remains inaccessible.
Local capabilities are claimed before body parsing and stream through an
exact-size atomic temporary file under bounded in-flight byte leases. Local
downloads use asynchronous, same-descriptor bounded streams with backpressure.
New session and attachment UUIDs use lowercase canonical spelling; database
case-fold uniqueness and exact local path spelling prevent case-distinct keys
from aliasing one physical object on case-insensitive filesystems.
Deployments still need HTTPS, access controls, retention, and backups.

The relay also bounds database allocation: 20,000 encrypted messages and
512 MiB of retained base64 ciphertext per session; 100,000 messages and 1 GiB
of retained message ciphertext per account; 200 encrypted artifacts and 1,000
KV rows per account. Usage reporting retains one fixed, bounded snapshot per
session, accepts at most 60 updates per account per minute on each relay
process, and bounds account-wide query materialization to 1,000 rows.
Idempotent message retries do not consume another row or
byte allocation at capacity.

Server-mediated voice commits an account-scoped database reservation before
each provider token request. The reserved duration is the configured agent
maximum, so operators must enforce the exact same maximum in ElevenLabs.
Provider tokens are never persisted.

Message reads use a metadata-first 16 MiB ciphertext budget and a 20 MiB final
response ceiling. Message uploads use a 6 MiB route-local body ceiling plus
pre-parsing per-account and process-wide in-flight reservations. Current
clients split outboxes to stay within the shared wire limit.

See [Encryption](../../docs/encryption.md), [HTTP API](../../docs/api.md), and
[Security](../../docs/SECURITY.md) for the complete boundary.

## Development

From the repository root:

```bash
yarn workspace @northglass/idle-wire build
yarn workspace @northglass/idle-server build
yarn workspace @northglass/idle-server test
```

The clean-checkout `dev` and `standalone:dev` scripts do not load dot-env files;
provide exactly one supported master-secret source before running them. For a
local full-stack runtime, use `docker compose up` with the non-echoing injection
documented in [Self-hosting](../../docs/SELF-HOSTING.md); its published ports bind
only to host loopback. The server package intentionally does not launch
PostgreSQL, Redis, or S3 containers with one-shot commands because those modes
need non-default credentials and explicit lifecycle controls. Inject their
credentials from an owner-scoped secret manager when
testing an operator-managed external-service deployment.

## License

MIT
