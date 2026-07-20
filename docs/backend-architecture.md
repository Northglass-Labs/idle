# Backend architecture

`@northglass/idle-server` is the authenticated relay used by Idle clients. It
combines a Fastify HTTP API, Socket.IO realtime transport, persistence, presence
tracking, optional integrations, and a static-web-app mount.

## Runtime shape

```text
Idle clients
  |-- HTTPS JSON --------------------> Fastify routes
  `-- Socket.IO /v1/updates --------> event router and RPC forwarding
                                            |
                                            +--> Prisma persistence
                                            +--> attachment storage
                                            `--> optional provider APIs
```

The default standalone runtime uses PGlite and the local filesystem under one
data directory, with an in-process event router. It requires no separately
managed database, cache, or object store.

Custom source deployments can select optional external PostgreSQL, Redis, and
S3-compatible storage. Redis supplies the Socket.IO streams adapter when
`REDIS_URL` is set; S3-compatible storage replaces local attachment storage
when its complete configuration is present. The standalone migration command
is specifically for PGlite, so external-database operators must own their
database migration process.

## Startup and shutdown

The packaged entrypoint is `sources/standalone.ts`; the reusable server factory
is `sources/index.ts`. Startup performs these gates in order:

1. Validate `IDLE_MASTER_SECRET` before serving traffic.
2. Connect persistence and register shutdown hooks.
3. Initialize relay token encryption, optional GitHub support, file storage,
   and authentication token handling.
4. Start Fastify, Socket.IO, metrics collection, presence batching, and timeout
   processing.

The server binds to loopback by default outside its container. The canonical
container explicitly binds its internal listener for container ingress.

## HTTP boundary

`startApi()` configures:

- a global 1 MiB body limit, with larger authenticated limits only on message
  batches and attachment uploads;
- request rate limiting keyed from the transport peer and only a trusted
  loopback proxy hop; unauthenticated account-pairing polls use an independent
  route budget so an abandoned restore page cannot starve live session sync;
- an exact browser-origin allowlist plus one optional exact HTTPS origin;
- security headers, Zod request/response schemas, and sanitized errors;
- account bearer authentication before protected route handlers;
- local file serving or an optional bundled web app.

Attachment admission atomically claims bytes and one object from a singleton
database ledger before creating a reservation. The ledger is shared across
accounts, processes, and storage modes. Cancellation and expired-reservation
cleanup release allocation in the same transaction that removes the reservation
after exact object cleanup. Session/account deletion transfers object identity
and size into the deletion outbox; workers release the charge only when storage
deletion succeeds and the corresponding jobs are acknowledged transactionally.

See [HTTP API](api.md) for the registered route catalog.

## Authentication

Clients first request a short-lived protocol-v3 challenge, sign its identity and
the locally selected canonical relay origin with their client signing key, and
exchange it once for a bearer token. The relay verifies against its required,
trusted `IDLE_AUTH_AUDIENCE`; request host and proxy headers cannot select the
security realm. Terminal pairing encrypts server-issued credentials to the
requesting client's box public key. Account pairing instead forwards an opaque
approver-signed v3 payload that binds the canonical relay, one-time requester,
account identity, bearer, and secret; the relay does not mint a substitute
account bearer for that flow.

`IDLE_MASTER_SECRET` is a relay secret used to issue and verify bearer
authentication tokens, protect any legacy server-readable GitHub OAuth token at
rest, and derive a pseudonymous voice participant identifier. It does not
decrypt client-encrypted session content or client content keys.

Bearer tokens are cached in memory after verification and can be revoked. They
must be protected in transit and at rest on clients.

## Realtime routing

Socket authentication completes before event handlers are attached. Each
connection joins account-prefixed rooms as one of:

- `user-scoped` — account-wide updates;
- `session-scoped` — a single session plus account updates relevant to it;
- `machine-scoped` — a specific daemon/machine.

Durable mutations allocate monotonic account or record sequence numbers, commit
to the database, then emit an `update`. Presence, online state, usage, and
notification signals are `ephemeral`. Versioned encrypted fields use optimistic
concurrency and return the current value on a version mismatch.

RPC registration and lookup are account-scoped. Current clients encrypt RPC
parameters and results with the session or machine key; method and routing
identifiers remain visible to the relay. Request ciphertext authenticates a
versioned identity, issue time, scope, method, and params. The target requires
that envelope and durably consumes the request identity before local dispatch;
raw legacy params, stale requests, route mismatches, replays, and replay-ledger
failures do not reach handlers.

## Persistence

Prisma models are defined in `prisma/schema.prisma`.

| Data | Relay storage behavior |
|---|---|
| Account public key, profile, and GitHub link | Server-readable identity and routing records |
| Sessions and messages | Server-readable identifiers/order; client-encrypted content |
| Machines | Server-readable identifiers/activity; client-encrypted metadata/state |
| Artifacts, KV, account settings, access keys | Versioned client-encrypted values |
| Attachments | Client-encrypted bytes in local or S3-compatible storage |
| Usage reports | Server-readable token and cost counts |
| Push tokens and notification title/body | Server-readable and sent to the push provider |
| Legacy GitHub OAuth credential | Encrypted at rest, but server-decryptable for revocation |
| Voice | Server-readable usage and provider responses; content enters the configured voice provider |

Relationship and feed tables remain migration-compatible schema only; no public
social or feed route is registered.

## Confidentiality boundary

Client account secrets and per-record content keys remain on authorized clients.
Session messages, session and machine metadata/state, artifacts, KV values,
account settings, access keys, and attachment bytes reach the relay as
ciphertext.

The server can decrypt a legacy GitHub OAuth token to revoke the provider grant
during authenticated disconnect. This is at-rest protection, not end-to-end
encryption. New OAuth initiation and callback routes are not registered.
Coding-agent authentication remains local to each provider CLI or SDK and is
not stored by the relay.

Routing identifiers, sequence and version counters, timestamps, activity,
usage reports, account profile fields, integration names, attachment sizes and
paths, push tokens, notification title/body, and voice identifiers remain
server-readable. See [Encryption](encryption.md) for byte layouts and limitations.

## Integrations and observability

- Legacy GitHub OAuth connections can only be disconnected; the runtime cannot
  create new links or receive GitHub webhooks.
- Voice can mint ElevenLabs conversation credentials using a server-owned key
  and agent identifier. RevenueCat entitlement checks are optional.
- `/health` verifies database connectivity.
- Metrics cover HTTP, WebSocket, RPC, presence, and database behavior. Metrics
  endpoints should remain on an administrative network.

## Source map

- Server lifecycle: `packages/idle-server/sources/index.ts`
- HTTP API: `packages/idle-server/sources/app/api/api.ts`
- Socket transport: `packages/idle-server/sources/app/api/socket.ts`
- Event routing: `packages/idle-server/sources/app/events/eventRouter.ts`
- Client-content crypto: `packages/idle-cli/src/api/encryption.ts`
- Relay credential crypto: `packages/idle-server/sources/modules/encrypt.ts`
- Persistence: `packages/idle-server/prisma/schema.prisma`
