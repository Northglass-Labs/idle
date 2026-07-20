# Realtime Sync and RPC

This is the high-level doc for how Idle uses Socket.IO for realtime sync and point-to-point RPC.

Related docs:
- `protocol.md`: wire contract, event names, and payload shapes
- `backend-architecture.md`: server subsystem overview
- `cli-architecture.md`: daemon and client-side socket ownership

## Core Pieces

Idle uses one Socket.IO endpoint at `/v1/updates` and three connection scopes:
- `user-scoped`: app/web clients and account-wide listeners
- `session-scoped`: one live session process
- `machine-scoped`: one daemon for one machine

On the server:
- `socket.ts` authenticates the handshake, tags the socket with `userId` and scope metadata, and enables the Redis streams adapter when `REDIS_URL` is set.
- `eventRouter.ts` handles fan-out for normal realtime updates.
- `rpcHandler.ts` handles `rpc-register`, `rpc-unregister`, and `rpc-call`.

On the client side:
- `ApiSessionClient` owns a long-lived session-scoped socket.
- `ApiMachineClient` owns a long-lived machine-scoped socket.
- the app's `apiSocket` owns a long-lived user-scoped socket.
- `RpcHandlerManager` registers handlers and re-registers them on reconnect.

## Room Model

Normal fan-out rooms:
- `user:<userId>`
- `user:<userId>:user-scoped`
- `user:<userId>:session:<sessionId>`
- `user:<userId>:machine:<machineId>`

RPC registration rooms:
- `rpc:<userId>:<prefixedMethod>`

The server uses room membership as the source of truth for who currently owns an RPC method.
Every connection carries the account authorization generation accepted during
its handshake. Session and machine connections also carry the durable object's
authorization generation. Object deletion commits first, then awaits an exact
room disconnect through the configured cluster adapter. Event handling and RPC
target selection revalidate both generations so a delayed or raced socket
cannot retain authority.

Account suspension also covers sockets that are still inside asynchronous
handshake authorization. After the first bearer check, the relay records a
bounded pending admission. Suspension cancels pending admissions on every
relay with acknowledgements before sweeping the established account room. The
handshake revalidates the exact bearer generation after scope ownership lookup
and promotes the admission only after the account room handoff. A failed relay
acknowledgement leaves the account suspended and surfaces an incomplete sweep
instead of reporting false success.

## Realtime Sync Flow

1. A client connects with a scope (`user-scoped`, `session-scoped`, or `machine-scoped`). Anonymous connection attempts first pass constant-state per-source and process-wide token buckets; rejected traffic cannot grow retained limiter state.
2. The server verifies the bearer, records the pending admission, checks scope ownership, revalidates the same account generation, and adds the socket to the appropriate user/session/machine rooms.
3. When durable state changes, `eventRouter` emits `update` events to the matching rooms.
4. When transient presence changes, the server emits `ephemeral` events to the matching rooms.
5. On reconnect, clients can re-fetch state if they missed anything while offline.

## RPC Flow

1. A session or machine target connects with its terminal-issued RPC registration credential and registers a scoped method.
2. The server verifies the credential purpose, owned scope, and current object
   generation before joining `rpc:<userId>:<method>`.
3. A user-scoped caller encrypts a versioned request ID, issue time, target
   scope, method, and params, then emits `rpc-call` with the visible routed
   method and opaque ciphertext.
4. `rpcHandler.ts` resolves the room, revalidates each target's object
   generation against durable state, and discards stale occupants.
5. If no target is present, the server waits briefly for reconnect before failing.
6. If exactly one target is present, the server forwards the request with `rpc-request`; multiple claimants fail closed as unavailable.
7. `RpcHandlerManager` authenticates the ciphertext, requires the inner route to
   match the outer route, enforces freshness, and durably consumes the request
   identity before running the handler. Raw, replayed, stale, or untrackable
   requests fail closed.
8. For a version 2 request, the target encrypts the result or a stable error code
   in a response envelope bound to the request scope, method, and ID.
9. The caller decrypts the response and requires those coordinates to match its
   retained outbound request before using the result. A captured response from
   another request fails closed.
10. If the target disappears mid-call, the server fails the call instead of waiting for the full timeout.

Authenticated version 1 requests remain a temporary compatibility input and
receive legacy raw encrypted results. Current clients send version 2 and never
downgrade after an invalid or missing bound response.

RPC metrics never use arbitrary method names as labels. Core methods map to a
reviewed finite catalogue, future or plugin methods aggregate under `other`,
and malformed envelopes aggregate under `invalid`.

Terminal credentials issued before the dedicated registration capability was
introduced cannot register a target. Pair the terminal again to obtain the
separate credential.

This is how Idle does point-to-point control traffic on top of the same transport used for normal realtime sync.

## Debugging

If this path is flaky, the first things to check are:
- RPC success/failure rate
- RPC latency
- websocket connection churn
- Redis stream lag
