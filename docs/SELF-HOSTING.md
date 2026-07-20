# Self-hosting Idle

The packaged Idle relay is one Node.js service with PGlite and local attachment
storage under a persistent data directory. External PostgreSQL, Redis, and
S3-compatible storage are optional source-deployment modes, not prerequisites.

Self-hosting moves ciphertext, routing metadata, account records, and any
server-readable integration data to infrastructure you operate. It does not
change the data boundaries of coding-agent providers, voice, push, analytics, or
GitHub. Read the [security model](SECURITY.md) before choosing a
deployment.

## Choose a deployment

| Path | Use it for | Guide |
|---|---|---|
| Docker Compose | Local evaluation on one computer | [Local Compose](#local-compose) |
| Docker behind HTTPS | An internet-facing Linux host | [Public Docker relay](#public-docker-relay) |
| Tailscale Serve | A tailnet-restricted relay | [Tailnet relay](#tailnet-relay) |
| Packaged Node.js server | A host without Docker | [Bare Node.js](#bare-nodejs) |
| Fly.io | Managed stateful container | [Fly.io](deploy-targets/fly.md) |
| Railway | Managed stateful container | [Railway](deploy-targets/railway.md) |
| Render | Managed stateful container | [Render](deploy-targets/render.md) |
| Vercel | Static web client only, not the relay | [Vercel web](deploy-targets/vercel-web.md) |

Provider interfaces and pricing change. Review the current provider terms before
creating resources or granting repository access.

## Required secret and storage

Every relay needs a unique `IDLE_MASTER_SECRET`: exactly 32 random bytes encoded
as 64 hexadecimal characters. It issues and verifies bearer authentication
tokens and protects any legacy server-readable GitHub OAuth token at rest. It
does not decrypt client-encrypted session content.

Generate the value once, store it in a scoped password or secret manager, and
inject it at runtime. Keep it out of Git, images, build arguments, command
arguments, logs, screenshots, and support requests. Persist the complete data
directory and treat the data plus this secret as one recovery set.

The relay accepts exactly one source: `IDLE_MASTER_SECRET` for transient
environment injection, or `IDLE_MASTER_SECRET_FILE` for an absolute path
provided by a secret manager. File input must be a single-link regular file
owned by root or the relay account, with mode `0400` or `0600`, and contain only
the 64 hexadecimal characters plus an optional final LF. Symlinks and broader
permissions are rejected.
After validation, the relay removes both source variables from its process
environment and keeps the live value only in private runtime memory, so child
processes and routine environment diagnostics cannot inherit it.

## Local Compose

This profile publishes the relay and web client only on host loopback.

```bash
git clone https://github.com/Northglass-Labs/idle.git
cd idle

(
  set -e
  cleanup() { stty echo 2>/dev/null || true; unset IDLE_MASTER_SECRET; }
  trap cleanup EXIT
  printf 'Idle master secret (64 hex characters): ' >&2
  stty -echo
  IFS= read -r IDLE_MASTER_SECRET
  stty echo
  printf '\n' >&2
  export IDLE_MASTER_SECRET
  docker compose up -d --build
)
curl --fail --silent --show-error http://127.0.0.1:3005/health
```

Paste the persistent value from your secret manager. Compose reads it from the
calling process, mounts it only into the relay as
`/run/secrets/idle_master_secret` with mode `0400`, and does not put the value in
the container environment. The subshell restores terminal echo and removes the
caller variable when Compose returns.

Open `http://127.0.0.1:8080` and point the CLI at the local relay:

```bash
IDLE_SERVER_URL=http://127.0.0.1:3005 idle
```

The `idle-data` volume survives `docker compose down`. Running `docker compose
down -v` deletes it. Do not expose either plaintext local port to a LAN or the
internet; use the public or tailnet layout below.

## Public Docker relay

Use a maintained Linux host with Docker Compose, a persistent volume, and an
HTTPS reverse proxy. For a manual start, read the stored value without echo:

```bash
git clone https://github.com/Northglass-Labs/idle.git
cd idle

(
  cleanup() { stty echo 2>/dev/null || true; unset IDLE_MASTER_SECRET; }
  trap cleanup EXIT
  printf 'Idle master secret (64 hex characters): ' >&2
  stty -echo
  IFS= read -r IDLE_MASTER_SECRET
  stty echo
  printf '\n' >&2
  export IDLE_MASTER_SECRET
  docker compose up -d --build idle-server
)

curl --fail --silent --show-error http://127.0.0.1:3005/health
```

The image runs database migrations before serving. Its listener binds inside the
container, while Docker publishes it only on host loopback. Put a TLS reverse
proxy in front of `127.0.0.1:3005`; do not expose the bare HTTP listener.
Compose defaults `IDLE_AUTH_AUDIENCE` to `http://localhost:3005` for this local
profile. Before clients use a public or tailnet URL, set it to that exact HTTPS
origin and recreate the relay container.
For unattended restarts, configure the host service manager or secret manager
to inject `IDLE_MASTER_SECRET` only into the `docker compose up` process. Compose
converts that value to the scoped mounted secret; do not persist it in a Compose
environment file.

A minimal nginx application block is:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Use a publicly trusted certificate and configure renewal. Before changing SSH,
firewall, or proxy policy, follow the
[self-hosted hardening checklist](deploy-targets/security-hardening.md) and keep a
recovery console available.

### Optional web client

The web client is configured for one relay at build time. Build it with your
public HTTPS relay origin:

```bash
docker build -f Dockerfile.webapp -t idle-webapp \
  --build-arg EXPO_PUBLIC_IDLE_SERVER_URL=https://relay.example.com .
docker run -d \
  --name idle-webapp \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  idle-webapp
```

Serve that loopback port through a separate HTTPS hostname. Add that exact web
origin to the relay with `IDLE_CORS_ORIGIN`; wildcards are rejected. The build
variable is public JavaScript configuration, so it must contain an origin only,
never credentials.

## Tailnet relay

Run the same Docker relay on host loopback, then publish it to an authenticated
tailnet with Tailscale Serve:

```bash
tailscale serve --bg localhost:3005
tailscale serve status
```

Use the HTTPS URL reported by Tailscale for the CLI and app. The app rejects raw
remote HTTP endpoints. Tailnet membership and ACLs remain part of the access
boundary; do not enable Funnel when the intent is private access.

## Bare Node.js

The published package provides migration and serve commands for the default
PGlite runtime:

```bash
npm install -g @northglass/idle-server

(
  set -e
  cleanup() { stty echo 2>/dev/null || true; unset IDLE_MASTER_SECRET; }
  trap cleanup EXIT
  printf 'Idle master secret (64 hex characters): ' >&2
  stty -echo
  IFS= read -r IDLE_MASTER_SECRET
  stty echo
  printf '\n' >&2
  export IDLE_MASTER_SECRET
  export IDLE_AUTH_AUDIENCE=http://localhost:3005
  export DATA_DIR="$HOME/.local/share/idle-server" HOST=127.0.0.1 PORT=3005
  idle-server migrate
  idle-server serve
)
```

Run both commands from the same installation and with the same absolute data
directory. For a long-running service, use a dedicated unprivileged account and
have its secret manager expose a credential file only to that service. Set
`IDLE_MASTER_SECRET_FILE` to the absolute runtime path; do not copy the value
into the unit, command line, or a shell-readable environment file. Put HTTPS or
Tailscale Serve in front of the loopback listener.

## Connect clients

CLI:

```bash
IDLE_SERVER_URL=https://relay.example.com idle
```

In the native app, open **Settings → Relay Server**, enter the same HTTPS origin,
confirm the server change, and pair with the CLI prompt. Changing relay servers
changes the account boundary and signs out the current relay session.

A web build cannot safely switch to an arbitrary relay at runtime. Build and
host the web app with `EXPO_PUBLIC_IDLE_SERVER_URL` set to your relay, as shown
above or in the [Vercel web guide](deploy-targets/vercel-web.md).

## Relay configuration

| Variable | Default | Purpose |
|---|---|---|
| `IDLE_MASTER_SECRET` | none | Direct 64-character hexadecimal relay secret; mutually exclusive with the file source |
| `IDLE_MASTER_SECRET_FILE` | none | Absolute path to the scoped secret file; mutually exclusive with the direct source |
| `IDLE_AUTH_AUDIENCE` | required | Exact public relay origin clients use, such as `https://relay.example.com`; HTTP is allowed only for loopback |
| `IDLE_ADMIN_SECRET` | none | Optional admin API secret; exactly 32 random bytes encoded as 64 hexadecimal characters |
| `IDLE_ACCOUNT_REGISTRATION_MODE` | `first-account` | Unknown signing-key policy: `first-account`, `closed`, or explicitly `open` |
| `IDLE_MAX_ACCOUNTS` | `1000` in `open` mode | Durable deployment-wide account ceiling; 1–1,000,000 |
| `IDLE_ATTACHMENT_STORAGE_LIMIT_BYTES` | `10737418240` (10 GiB) | Durable deployment-wide attachment allocation ceiling; positive integer up to 1 PiB |
| `IDLE_ATTACHMENT_STORAGE_LIMIT_OBJECTS` | `2000` | Durable deployment-wide attachment object ceiling; 1–10,000,000 |
| `PORT` | `3005` | HTTP and Socket.IO port |
| `HOST` | `127.0.0.1` outside containers | Listener address |
| `DATA_DIR` | `./data` in the package runtime | PGlite and local-file base directory |
| `PGLITE_DIR` | `<DATA_DIR>/pglite` | Embedded database path |
| `PUBLIC_URL` | trusted request origin | Optional clean HTTP(S) origin for local attachment links; do not include credentials, a path, query, or fragment |
| `IDLE_CORS_ORIGIN` | none | One additional exact HTTPS browser origin |
| `ELEVENLABS_API_KEY` | none | Optional server-side voice credential |
| `ELEVENLABS_AGENT_ID` | none | Required with server-mediated voice; selects the server-owned agent |
| `ELEVENLABS_MAX_CONVERSATION_SECONDS` | none | Required with server-mediated voice; must exactly match the agent's enforced `max_duration_seconds` (1–3600) |

External PostgreSQL, Redis, and S3-compatible modes require complete source
configuration plus an operator-owned migration, scaling, and backup plan. See
[backend architecture](backend-architecture.md); the packaged migration command
is the PGlite path.

`IDLE_AUTH_AUDIENCE` is a security-realm identifier, not a value learned from
the request. The client signs it into every direct-auth proof and the relay
verifies the independently configured value. Use a credential-free origin with
no path, query, or fragment; default ports are canonicalized. A custom relay
rejects authentication if the client-selected origin differs. Multiple DNS
aliases are distinct realms unless clients deliberately use one canonical
origin. Protocol-v2 direct authentication is not accepted.

### Account admission

A fresh relay defaults to `first-account`: exactly one previously unknown
signing key may create the initial account, even when concurrent registration
requests reach different relay replicas. After that, existing account keys can
continue to authenticate and additional devices should use the authenticated
pairing flow. Set `closed` to pre-provision or restore only existing accounts.

Public services must opt into `open` registration and set a deliberate
`IDLE_MAX_ACCOUNTS`. The relay maintains that count in the database, backfills
it during migration, increments it in the same transaction as account creation,
and decrements it with account deletion. Invalid registration configuration
fails closed for unknown keys. An account ceiling bounds principal creation but
does not replace ingress abuse controls or the deployment-wide attachment
storage accounting.

### Attachment storage budget

Attachment reservations and retained encrypted objects share one durable
deployment-wide byte and object budget. The ledger lives in the database, so a
restart, another relay replica, account deletion, a new signing key, or a switch
between local and S3-compatible storage cannot reset it. Invalid limit values
fail closed for new reservations. Per-session and per-account attachment quotas
still apply in addition to this deployment boundary.

The migrations conservatively charge every existing `Attachment` row and treat
pre-existing reservations as direct-storage capabilities. A pending
relay-mediated reservation may release its allocation after expiry only after
the exact storage key has been removed. A direct S3 capability is never reaped
merely because its policy expired: it remains owned and quota-charged, and an
exact-size late object can still be confirmed. This intentionally trades some
capacity for a failed direct upload for protection against a storage commit that
finishes after cleanup. Session and account deletion enqueue object deletion
while retaining the charge; the relay releases it transactionally only after
the storage backend confirms deletion. Failed deletion jobs therefore remain
charged and retry safely instead of creating free orphaned objects.

The identity migration preserves a lone legacy mixed-case session row while
requiring canonical lowercase spelling for new session and attachment UUIDs.
It also creates case-folded unique indexes. An upgrade intentionally stops if
the database already contains case-distinct session IDs, attachment IDs, or
attachment refs that would name the same path on a case-insensitive filesystem;
resolve those conflicting rows during the maintenance window before retrying.

For external PostgreSQL deployments, stop writers or use a maintenance window
while applying this migration and deploying the matching relay code. Otherwise,
an older replica could enqueue an unaccounted legacy deletion between the
backfill and the new code becoming active.

## Voice

Voice stays off until configured. In direct bring-your-own-agent mode, the app
connects to the selected ElevenLabs agent and the relay needs no provider key.

Server-mediated voice requires `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and
`ELEVENLABS_MAX_CONVERSATION_SECONDS`. Configure the ElevenLabs agent's
`conversation.max_duration_seconds` to the exact same duration before enabling
the relay. The relay reserves that complete duration in durable, account-scoped
capacity before asking ElevenLabs to mint a token. This prevents concurrent
requests or multiple relay replicas from outrunning the rolling allowance. A
definite provider rejection releases the reservation; an ambiguous response is
retained until provider history confirms completion or its conservative lease
expires. Reservations contain no provider token or voice content.

The relay uses its own credential and server-owned agent to mint a conversation
token; a client-supplied identifier does not replace that agent. Voice content
and identifiers enter ElevenLabs' provider boundary in either mode.

Specifically, while voice is active, ElevenLabs receives microphone audio,
active-session titles and summaries, current and relevant background-session
transcript updates, opaque session and request identifiers, and permission tool
names needed for multi-session control. Idle does not separately forward stored
project paths or permission arguments. Transcript text can itself contain
sensitive data. Self-hosting the relay does not remove this provider boundary.

## Verify, back up, and upgrade

After deployment:

1. Request `GET /health` through the final HTTPS or tailnet URL.
2. Pair a disposable client and send a message in both directions.
3. Restart or redeploy the same revision and confirm the pairing survives.
4. Confirm only intended ports are reachable from outside the host.
5. Inspect logs for credentials, message bodies, paths, and identifiers before
   configuring retention or export.
6. Back up the data directory and relay secret, then test a restore in an
   isolated environment.

Stop the relay or use a storage-consistent snapshot before copying live PGlite
files. Keep one active relay process attached to a PGlite data directory. Review
migrations and release notes before upgrading; retain a recoverable backup until
the upgraded relay and paired clients are verified.

## Security checklist

- Require HTTPS/WSS for every non-loopback connection.
- Keep the relay listener, data store, metrics, and admin API off the public
  network except through an intentional access boundary.
- Protect `IDLE_MASTER_SECRET`; rotating it invalidates authentication material
  and any retained legacy GitHub OAuth token, so recovery must be planned.
- Revoke legacy GitHub connections after upgrade. The current runtime does not
  create new links, but a retained token remains relay-decryptable until an
  authenticated disconnect removes it. Coding-agent credentials stay local to
  their provider CLI or SDK.
- Keep rate limits and exact origin checks enabled.
- Use least-privilege host accounts, timely OS/container updates, and tested
  certificate renewal.
- Redact credentials, private project data, absolute paths, hostnames, and live
  identifiers from support material.

## Troubleshooting

| Symptom | Check |
|---|---|
| Relay refuses to start | Exactly one master-secret source is set; the direct value is 64 hexadecimal characters, or the file satisfies the ownership, mode, and content checks above |
| Data disappears after a restart | The same persistent data directory or `/data` volume is mounted |
| Browser cannot connect | Relay URL is HTTPS, `IDLE_CORS_ORIGIN` exactly matches the web origin, and the proxy forwards WebSocket upgrades |
| Native app rejects a custom relay | The URL is HTTPS and its certificate is trusted by the device platform |
| Server-mediated voice is unavailable | All three ElevenLabs variables are set, the configured agent belongs to the relay operator, and its enforced `max_duration_seconds` exactly matches the relay value |

The relay requires a long-running HTTP/WebSocket process and durable storage.
Stateless function platforms are suitable for the compiled web app, not for the
relay itself.
