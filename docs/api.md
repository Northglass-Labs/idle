# HTTP API

Idle uses JSON over HTTP for authentication, reads, and durable actions. Realtime
updates use Socket.IO; see [Protocol](protocol.md). Encryption and visibility
boundaries are in [Encryption](encryption.md).

## Authentication

Unless marked otherwise, routes require `Authorization: Bearer <token>` and
scope database access to the authenticated account. TLS is still required: a
bearer token authorizes the holder.

Direct authentication is an audience-bound, single-use protocol-v3 challenge:

1. `POST /v1/auth/challenge` with `{ version: 3, publicKey }` returns
   `{ version: 3, challengeId, challenge }`.
2. The client independently canonicalizes its selected relay origin and signs
   the protocol-v3 message containing that audience and both returned values.
3. `POST /v1/auth` with `{ version: 3, publicKey, challengeId, signature }`
   consumes the challenge and returns `{ success: true, token }`.

Public keys and signatures are base64. Invalid, expired, mismatched, replayed,
cross-relay, and protocol-v2 challenges fail. The relay checks its configured
`IDLE_AUTH_AUDIENCE`, never `Host` or forwarding headers. Proof of possession
authenticates an existing account; new keys follow durable registration policy:
first-account-only by default, none when `closed`, or a deployment-bounded
ceiling when explicitly `open`. Rejection uses the generic credential error.

Device and terminal pairing uses public-key encryption:

- `POST /v1/auth/request` accepts `{ publicKey, supportsV2: true }`; polling it
  returns `{ state: "requested" }` or a one-time encrypted response.
- `GET /v1/auth/request/status?publicKey=...` reports `not_found`, `pending`, or
  `authorized` plus `supportsV2`; `POST /v1/auth/response` approves a pending
  terminal request with `{ publicKey, response }`.
- `POST /v1/auth/account/request` requires `{ version: 3, publicKey }` and has a
  separate 30/minute source budget; clients poll every three seconds for at most five minutes.
- `POST /v1/auth/account/response` is authenticated and requires
  `{ version: 3, publicKey, response }`. `response` is the opaque encrypted,
  account-signed v3 transcript; the relay stores and returns it unchanged.

Pending and approved pairing requests expire after five minutes; approval and
redemption enforce expiry independently of cleanup. Stale approval returns the
same `404 Request not found` as a missing request, while polling starts a fresh
request without returning old ciphertext. Only the first fresh approval wins;
later or racing approvals receive `409 Pairing request already approved`, which
clients surface as a security warning.

Terminal pairing returns an ordinary bearer plus a distinct RPC-registration
credential for session- and machine-scoped CLI sockets; the latter is not valid
for HTTP or user scope. Account pairing instead signs the relay audience,
one-time requester key, account signing key, current bearer, and 32-byte account
secret, then encrypts that payload to the requester. The relay mints no
replacement account credential, and both devices compare a signature-derived
48-bit code before persistence. Schemas live in `@northglass/idle-wire`.
Version 3 is a hard cutover: older Agent credentials must re-pair, while
pre-split terminal credentials retain sync but require re-pairing for RPC.

## Confidentiality boundary

Client-encrypted session messages, session and machine state, artifacts, KV
values, access keys, account settings, and attachment bytes are opaque to the
relay. Route names, account and record identifiers, sequence/version numbers,
timestamps, activity, usage reports, attachment size/path, account profile,
push tokens, notification title/body, voice data, and any legacy GitHub
connection state are server-readable.

A legacy GitHub OAuth token is encrypted at rest with a key derived from
`IDLE_MASTER_SECRET`, but the server can decrypt it for provider revocation. It
is not end-to-end encrypted. The current runtime registers no OAuth initiation
or callback route. Coding-agent credentials remain local to their provider CLI
or SDK and are not stored by the relay.

## Route catalog

The source schemas remain authoritative for request and response fields. This
catalog records the complete registered HTTP surface.

### Service and unauthenticated entry points

- `GET /` provides the service banner; `GET /health` reports database readiness;
  `POST /v1/version` performs client update lookup.
- `GET /files/*` — local-file mode objects in the explicit `public/` image
  namespace only. Session attachments use the authenticated attachment routes.
- Authentication entry points: `POST /v1/auth/challenge`, `POST /v1/auth`,
  `POST /v1/auth/request`, `GET /v1/auth/request/status?publicKey=...`, and
  `POST /v1/auth/account/request`.
- `GET /admin` — login shell only; admin data routes use a separate secret.

### Authenticated account and session routes

- Pairing approval: `POST /v1/auth/response` and
  `POST /v1/auth/account/response`.
- Account state: `GET /v1/account/profile`, `GET /v1/account/settings`,
  `POST /v1/account/settings`, `POST /v1/account/delete`, and
  `POST /v1/usage/query`.
- Session inventory: `GET /v1/sessions`, `GET /v2/sessions/active?limit=...`, and
  `GET /v2/sessions?cursor=...&limit=...&changedSince=...`.
- Session lifecycle: `POST /v2/sessions` is the current UUID-required
  create-or-load contract; `POST /v1/sessions` is the optional-UUID compatibility
  route; `POST /v1/sessions/:sessionId/archive` and
  `DELETE /v1/sessions/:sessionId` close sessions.
- Messages: `GET /v1/sessions/:sessionId/messages`,
  `GET /v3/sessions/:sessionId/messages?after_seq=...&limit=...`, and
  `POST /v3/sessions/:sessionId/messages`.

Usage queries accept an optional owned `sessionId`, bounded Unix-second
`startTime`/`endTime`, and `groupBy: "hour" | "day"`. An inverted range is
rejected. The relay retains at most one fixed-shape usage snapshot per session
and refuses to aggregate a legacy result above the account session limit.

Current clients send a random UUID to `POST /v2/sessions`, binding initial
ciphertext to its record. Unsupported relays reject before creating an
unreadable row. ID collisions return `409 SESSION_ID_CONFLICT`; an existing
same-account tag remains idempotent. Older clients use `POST /v1/sessions` and
may receive a relay-generated ID.

Current CLI and Agent account-bearer requests do not follow redirects. Session
creation also enforces finite request, response, and time limits and validates
the bounded shared Wire response before unwrapping a data key or decrypting
fields. Ambiguous network failures are safe to retry with the same
client-selected coordinate.

Message history is selected metadata-first and materializes at most 16 MiB of
validated ciphertext into a response capped at 20 MiB. Paginated v3 reads
return `hasMore`; the unpaginated legacy route fails closed with
`MESSAGE_HISTORY_RESPONSE_LIMIT` rather than returning a partial history.
Authenticated v3 message uploads are capped at 6 MiB per JSON body. The relay
reserves that full allowance per in-flight request before parsing, with bounded
per-account and process-wide concurrency; official clients split larger
outboxes without reordering messages.

### Machines, artifacts, keys, and KV

- Machines: `POST /v1/machines`, `GET /v1/machines`,
  `GET /v1/machines/:id`, and `DELETE /v1/machines/:id`.
- Artifacts: `GET /v1/artifacts`, `GET /v1/artifacts/:id`,
  `POST /v1/artifacts`, `POST /v1/artifacts/:id`, and
  `DELETE /v1/artifacts/:id`.
- Access keys: `GET /v1/access-keys/:sessionId/:machineId`,
  `POST /v1/access-keys/:sessionId/:machineId`, and
  `PUT /v1/access-keys/:sessionId/:machineId`.
- KV: `GET /v1/kv?prefix=...&limit=...` (up to 100 items and a 4 MiB encoded
  response; check `truncated`), `GET /v1/kv/:key`, `POST /v1/kv`, and
  `POST /v1/kv/bulk`.

New encrypted messages are limited to 20,000 rows and 512 MiB of retained
base64 ciphertext per session, and 100,000 rows and 1 GiB per account.
`POST /v3/sessions/:sessionId/messages` returns `429 MESSAGE_LIMIT_REACHED`
before allocating another row or ciphertext byte; retrying an already stored
`localId` remains idempotent at the limit. The legacy live-socket message path
applies the same durable limits.

Artifacts are limited to 200 per account, matching the bounded artifact list.
HTTP creation returns `429 ARTIFACT_LIMIT_REACHED` at capacity, and the legacy
socket creation path returns the same code in its error acknowledgement.
Same-account retries of an existing artifact ID remain idempotent.

### Attachments and push

- Attachments: `POST /v1/sessions/:sessionId/attachments/request-upload`,
  `PUT /v1/sessions/:sessionId/attachments/:attachmentFile`,
  `POST /v1/sessions/:sessionId/attachments/request-download`, and
  `GET /v1/sessions/:sessionId/attachments/:attachmentFile`.
- Push: `POST /v1/push-tokens`, `GET /v1/push-tokens`,
  `DELETE /v1/push-tokens/:token`, and
  `POST /v1/sessions/:sessionId/push-event`.

Attachment request routes verify session ownership. Local upload/download routes
require bearer authentication; an S3-compatible deployment can instead return
short-lived presigned operations for encrypted bytes. Upload capabilities are
backed by 15-minute database reservations and the actual encrypted object must
match the reserved size. Pending reservations and retained objects share the
same quotas: 200 objects / 1 GiB per session, 2,000 objects / 10 GiB per account,
and a durable deployment-wide ledger that defaults to 2,000 objects / 10 GiB,
with a 10 MiB limit for each encrypted blob. The shared ledger applies across
accounts, relay replicas, and local/S3 storage. Allocation is released only
after cancellation or confirmed object deletion. Local public-file URLs serve
only the explicit `public/` image namespace; session attachments are available
only through the authenticated attachment routes.

In local mode, the relay atomically consumes the reservation and acquires a
bounded per-account/process byte lease before its streaming parser reads the
body. It writes through an exact-size counter to an `fsync`ed temporary file
and publishes only by atomic rename. Local downloads use an asynchronous
same-descriptor size check and a backpressure-aware stream under the same
aggregate transfer budget; neither direction materializes a complete
attachment in relay application memory.

### Integrations and voice

- Integrations: `DELETE /v1/connect/github`; voice uses
  `POST /v1/voice/conversations`, `GET /v1/voice/usage`, and the older-client compatibility route `POST /v1/voice/token`.

Server-funded voice uses server-owned ElevenLabs configuration; client-supplied
agent identifiers do not select the server's agent. Both token-mint endpoints
commit the same durable account-scoped capacity reservation before contacting
the provider. Modern clients send a UUID `requestId`; older clients remain
compatible through a relay-generated coordinate.

### Optional admin API

These routes do not accept account bearer tokens. They require
`X-Admin-Secret` matching an `IDLE_ADMIN_SECRET` containing exactly 32 random
bytes encoded as 64 hexadecimal characters; otherwise they return `503`. Admin
responses use `Cache-Control: no-store`, and each API route permits at most five
attempts per source per minute. The panel keeps the supplied secret only in its
page-memory closure, so refreshing or locking the page requires re-entry.

- `GET /v1/admin/accounts` — includes each account's enabled or suspended authentication status.
- `POST /v1/admin/accounts/:userId/revoke` — suspends account-key authentication, revokes existing bearer generations, and disconnects live sessions.
- `POST /v1/admin/accounts/:userId/enable` — explicitly permits the suspended account key to authenticate again; old bearer tokens remain invalid.
- `POST /v1/admin/cleanup-stale?execute=true`

## Implementation references

- Route registration and schemas: `packages/idle-server/sources/app/api/api.ts` and `packages/idle-server/sources/app/api/routes`
- Authentication: `packages/idle-server/sources/app/auth/auth.ts`
- Request limits and origins: `packages/idle-server/sources/app/api/requestSecurity.ts`
