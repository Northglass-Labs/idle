# Realtime protocol

Idle uses Socket.IO for realtime synchronization and RPC forwarding. HTTP
authentication and route names are documented in [HTTP API](api.md); payload
confidentiality is documented in [Encryption](encryption.md).

## Transport and browser origins

The Socket.IO server uses path `/v1/updates` with WebSocket and polling
transports. The bearer token is supplied in the Socket.IO `auth` object.

Browser CORS accepts a small built-in set of Idle and local-development origins
plus one operator-configured exact browser origin. Wildcards are rejected. CORS
is a browser control, not authentication; non-browser clients still need a valid
bearer token.

## Handshake

```ts
{
  token: string;
  clientType?: 'user-scoped' | 'session-scoped' | 'machine-scoped';
  sessionId?: string;
  machineId?: string;
  appState?: 'active' | 'background';
}
```

Omitted `clientType` behaves as `user-scoped`. A `session-scoped` connection
must include `sessionId`; a `machine-scoped` connection must include
`machineId`. Rooms are also prefixed by the authenticated account, preventing a
client from selecting another account's room by guessing an identifier.

## Server-to-client events

### `update`

Durable synchronization envelope:

```ts
{
  id: string;
  seq: number;       // account-wide monotonic update sequence
  body: { t: string; /* event-specific fields */ };
  createdAt: number; // epoch milliseconds
}
```

Registered body discriminators:

- `new-session`, `update-session`, `delete-session`
- `new-message`
- `update-account`
- `new-machine`, `update-machine`, `delete-machine`
- `new-artifact`, `update-artifact`, `delete-artifact`
- `kv-batch-update`

`metadata`, `agentState`, `daemonState`, message `content.c`, artifact values,
KV values, and account settings are ciphertext-bearing fields. Record IDs,
sequence numbers, versions, timestamps, and activity fields are not encrypted.

The shared package validates the core `new-message`, `update-session`, and
`update-machine` forms with `CoreUpdateContainerSchema`. Server-only event
variants are defined beside the event router until they move into that shared
contract.

### `ephemeral`

Transient events are not replayable durable state:

- `activity` — session ID, active state, timestamp, optional thinking flag.
- `machine-activity` — machine ID, active state, timestamp.
- `machine-status` — machine ID, online state, timestamp.
- `usage` — session ID, provider key, token/cost counts, timestamp.
- `session-event` — session ID, kind, title, body, timestamp.

`session-event` carries `title` and `body`; both are server-readable and may be
forwarded to a push provider. Clients must not put session transcript content or
secrets in those fields.

### RPC control events

- `rpc-request` — delivered to the registered target with `{ method, params }`
  and an acknowledgement callback.
- `rpc-registered` and `rpc-unregistered` — registration confirmation.
- `rpc-error` — bounded validation or internal registration error.

RPC method names are visible routing metadata. Current Idle clients encrypt
`params` and acknowledgement results with a session or machine content key.
Inside request ciphertext, clients include a strict versioned envelope binding
the request ID, issue time, scope, method, and params. The generic relay accepts
an opaque value and cannot enforce this client-side contract; the target CLI
rejects plaintext-shaped or legacy raw params, stale or future-dated requests,
scope/method mismatches, and previously consumed identities before dispatch.
For version 2 requests, the target encrypts a strict response envelope binding
the result or stable error code to the same scope, method, and request ID. The
caller rejects mismatched, raw, legacy, or malformed responses, preventing a
relay from replaying a captured result into a later control request.

## Client-to-server events

Every event is checked against the immutable scope established at the
handshake. Session events require the exact `sessionId`; daemon state and
presence require the exact `machineId`. User-scoped sockets are limited to the
explicit account-wide app-state, RPC-call, and machine-display-metadata paths.
Authorization failures use a generic response and do not echo either target ID.

### Durable encrypted values

- `message` — `{ sid, message, localId? }`; `message` is base64 ciphertext.
- `update-metadata` — `{ sid, metadata, expectedVersion }`.
- `update-state` — `{ sid, agentState, expectedVersion }`.
- `machine-update-metadata` — `{ machineId, metadata, expectedVersion }`.
- `machine-update-state` — `{ machineId, daemonState, expectedVersion }`.

Artifact and access-key operations use the authenticated HTTP routes documented
in the [API reference](api.md); their obsolete socket variants are not exposed.

Versioned writes acknowledge `success`, `version-mismatch`, or `error`. A
version mismatch includes the current encrypted value so the client can
reconcile without the relay decrypting it.

Current session metadata and agent-state ciphertext contains an authenticated
inner envelope binding `sessionId`, field name, and the resulting field
`version`. For a write with `expectedVersion: n`, the producer binds the value
to version `n + 1`. Initial record creation uses a client-selected random
session ID and binds version 0. Current live readers require an exact inner and
outer match before advancing a version or running state-derived effects.
Legacy raw values may be displayed after a full initial fetch, but are rejected
on the live update path and migrate to the bound format on a current-client
write.

Current session-creating clients must be paired with a relay that accepts and
preserves their requested UUID. A relay that substitutes its own ID causes the
echoed version-0 envelope to fail its binding check; clients report the minimum
relay compatibility error instead of continuing with unreadable state. The
current relay still accepts create requests from older clients that omit the
ID.

### Presence and accounting

- `session-alive` and `session-end` update server-readable presence.
- `machine-alive` updates server-readable machine presence.
- `usage-report` stores one server-readable `claude-session` snapshot for the
  exact authenticated session. The payload has fixed token and cost fields;
  token totals must equal their component sum. Reports are rate-limited per
  account and are deleted with their session.
- `app-state` sends `{ state: 'active' | 'background' }` for push suppression.
- `ping` acknowledges with `{}`.

### RPC

- `rpc-register` — `{ method }`.
- `rpc-unregister` — `{ method }`.
- `rpc-call` — `{ method, params? }`, acknowledged as
  `{ ok: true, result }` or `{ ok: false, error }`.

The acknowledgement is only the relay transport envelope. For a successful
version 2 call, `result` is ciphertext containing
`{ kind: "idle-rpc-response", v: 2, scope, method, requestId, ok, ... }`.
Current callers retain the outbound identity until decryption and require all
three coordinates to match before using the result.

Method names are bounded before being used in room names. RPC targets are
resolved only inside the authenticated account and calls cannot target the
originating socket. Ambiguous rooms with multiple target sockets fail closed
instead of selecting a claimant. Registering a target additionally requires
the dedicated RPC registration credential delivered through terminal pairing. An ordinary
app/API bearer cannot register a target even when it claims an owned session or
machine scope. The registration credential is rejected by HTTP routes and
user-scoped sockets. Terminal credentials issued before this capability split
remain usable for ordinary sync but must be paired again to register RPC
targets.

The target consumes current request identities in an owner-only durable replay
ledger before invoking a handler. Capacity exhaustion and ledger I/O or
integrity errors fail closed instead of evicting an executable identity. Replay
markers are digests only; command text, params, keys, and request identifiers
are not stored in the ledger.

During the version 2 migration, targets accept authenticated version 1 request
envelopes and return legacy raw encrypted results to those callers. New callers
always send version 2, require a bound version 2 response, and never retry by
downgrading. Raw params are not accepted in either mode.

This provides at-most-once dispatch, not transactional exactly-once execution.
A target crash after consuming the identity can leave the caller uncertain
whether a handler started or completed; retrying that identity remains rejected
to prevent duplicate side effects.

## Ordering and recovery

- `update.seq` orders durable account updates.
- Sessions, machines, artifacts, and messages have record-specific sequence
  numbers.
- Versioned values use compare-and-swap semantics.
- Ephemeral events are advisory. After reconnect, clients refetch durable state
  rather than treating missed ephemeral events as authoritative.

## Shared schemas

`@northglass/idle-wire` contains Zod schemas for encrypted message containers,
core update envelopes, authenticated session-field coordinates, decrypted
legacy/session message shapes, voice HTTP responses, and authentication pairing
payloads. Schemas validate structure; cryptography remains in the clients and
server authentication modules.

Account linking uses a strict v3 payload distinct from terminal pairing. The
approver signs a fixed-order transcript over the canonical relay audience,
requester's ephemeral box key, account signing key, bearer, and account secret,
then encrypts it to the requester. The requester verifies all transcript fields
and the secret-derived account key before asking the user to enter the 48-bit
code displayed by the approver. The relay only arbitrates a single-use request
and returns the opaque ciphertext unchanged.

## Implementation references

- Socket setup: `packages/idle-server/sources/app/api/socket.ts`
- Socket handlers: `packages/idle-server/sources/app/api/socket`
- Event types and routing: `packages/idle-server/sources/app/events/eventRouter.ts`
- Shared schemas: `packages/idle-wire/src`
