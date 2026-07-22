# Idle security model

Idle encrypts coding-session content on authorized clients before relay
transport. The relay routes and stores ciphertext without receiving the
plaintext session keys needed to open that content. This is a scoped boundary,
not a claim that every Idle field or integration is end-to-end encrypted.

## Data boundaries

| Data | Protection | Relay visibility |
|---|---|---|
| Session messages, metadata, and agent state | Client-authenticated encryption | Ciphertext plus routing metadata |
| Shared file and attachment bytes | Client-authenticated encryption | Ciphertext plus object metadata and size |
| Machine state, artifacts, KV values, settings, and access-key payloads | Client-authenticated encryption | Ciphertext plus record metadata |
| Current RPC parameters and results | Client-authenticated encryption | Ciphertext; route and method identifiers remain visible |
| Legacy connected GitHub OAuth credential | Server-side encryption at rest | The relay can decrypt it only to revoke an existing connection |
| Push token, notification title and body | Server-readable | May be sent to the configured push provider |
| Account profile, usage, activity, identifiers, versions, and timestamps | Server-readable | Used for product and routing behavior |
| Voice requests, responses, identifiers, and usage | Provider-dependent | Enter the configured voice-provider boundary |

Do not put transcript content or secrets in notification title or body. Voice,
push, analytics, GitHub, and provider CLIs each have their own data
handling terms and configuration.

### Voice provider boundary

Voice is optional. While it is active, Idle sends microphone audio to
ElevenLabs. Multi-session control also requires active-session titles and
summaries, current and relevant background-session transcript updates, opaque
session and request identifiers, and permission tool names to enter that
provider boundary. Idle does not separately forward stored project paths or
permission arguments; ordinary tool-call names, descriptions, and arguments
are not forwarded. Transcript text can itself contain sensitive data.
Provider-visible text is bounded, and recent history is selected newest-first
before being presented chronologically. Injected titles, summaries, and
transcript updates are treated as untrusted data rather than sufficient
authority for a client-tool call. The provider prompt directs the voice agent
to act only on live microphone speech, but the enforceable client boundary is
local review: every outbound coding-session message is limited to 1 KiB and
shown in full for confirmation on the device. Every permission allowance shows
the locally authenticated tool name and requires local confirmation; a denial
remains the fail-safe exception. Idle rechecks the exact target and permission
request after review.

## Client keys

Idle creates a random client account secret during setup. Native clients store
it in platform secure storage; the CLI and Agent use permission-restricted local
credential files. Pairing can transport an encrypted copy through the relay, but
the relay does not receive the one-time key needed to unwrap it.

The client account secret is separate from the relay's `IDLE_MASTER_SECRET`.
Clients use their secret to derive account key material and unwrap per-record
content keys. New sessions, machines, and artifacts receive independent random
data keys. Attachment bytes use a separate blob-key derivation.

`IDLE_MASTER_SECRET` belongs to the relay. It issues and verifies bearer
authentication tokens, protects any legacy server-readable GitHub OAuth
credential at rest, and derives a voice pseudonym. It does not derive the client
account secret or decrypt client-encrypted session content.

See [encryption.md](encryption.md) for algorithms, byte layouts, legacy readers,
and the complete field inventory.

## Authentication and pairing

Direct authentication uses an audience-bound, single-use protocol-v3 challenge:

1. The client requests a challenge for its public signing key.
2. It signs canonical bytes containing the challenge and the canonical relay
   origin it selected locally.
3. The relay verifies that signature against its independent
   `IDLE_AUTH_AUDIENCE`, consumes the challenge, and issues a bearer token.

The server never derives its audience from request or proxy headers. A live
challenge and proof forwarded to a different relay therefore fail verification;
missing, unknown, and protocol-v2 versions fail closed.

For existing accounts, that proof is authentication. For unknown keys, account
creation separately requires the relay's durable admission policy. A fresh
self-hosted relay admits only its first account by default; closed registration
admits none, and explicitly open registration has a cross-replica deployment
cap. Account deletion releases one slot in the same database transaction.

Attachment allocation is separately bounded by a database-backed deployment
ledger in addition to per-session and per-account quotas. It covers pending
reservations and retained encrypted objects across every account, relay replica,
and local or S3-compatible storage mode. Account deletion does not prematurely
free this capacity: queued objects remain charged until storage deletion is
confirmed and the queue acknowledgement releases the allocation in the same
database transaction. Expired relay-mediated reservations are reaped only while
still pending. Issued direct-S3 capabilities remain owned and charged after
expiry, allowing an exact-size late object to be confirmed instead of becoming
an untracked storage object. Invalid deployment limits fail closed for new
uploads.

A bearer token authorizes its holder and therefore requires TLS and protected
client storage. Account revocation invalidates existing bearer generations and
disconnects active sockets.

Terminal and device pairing use a short-lived request plus public-key encryption.
Pending and approved requests share the same five-minute lifetime. Approval and
redemption enforce expiry independently of cleanup, successful redemption is
single-use, and approval requires an explicit confirmation in the app. Every
QR, manual-paste, native-link, and web-link terminal path crosses the same
confirmation immediately before credential issuance. The prompt displays a
fingerprint derived from the complete requester public key and explains that
the terminal receives durable account authority, including destructive account
operations. Cancellation sends no approval. A second or racing approval
receives an explicit conflict instead of a success response.

Account linking uses a hard-cutover v3 transcript. The approving app signs the
canonical relay audience, requester's one-time box key, account signing key,
current bearer, and 32-byte account secret with the signing key derived from
that secret. It then encrypts the complete signed payload to the requester. The
relay stores only that opaque ciphertext and cannot substitute a different
account, bearer, requester, or relay audience without invalidating the
signature. The requester independently derives the account signing identity
from the recovered secret and verifies every binding.

Cryptographic verification is followed by an out-of-band human check: the
approving app displays a 48-bit code derived from the signature, and the new
device or Agent must enter the same code before credentials are saved. A relay
that constructs a different, internally valid account payload cannot make the
intended approving app display its matching code. Missing, canceled, or
mismatched confirmation fails closed. Account-linking clients that omit v3 and
legacy unbound Agent credential files must re-pair.

Terminal pairing retains its distinct encrypted payload and also supplies a
separate credential for registering session- and machine-scoped RPC targets;
an ordinary API bearer cannot register one. The current terminal flow does not
transfer the account secret or content private key, but its API bearer can act
broadly on account-owned data and must be protected and revoked if the terminal
is no longer trusted.

## Remote-control boundary

Idle keeps normal provider approvals enabled by default. Sandbox selection and
permission approval are separate controls: choosing a sandbox does not enable an
approval bypass. `--yolo`, Claude's `--dangerously-skip-permissions`, and
`--no-sandbox` are explicit reductions in protection. Review
[permission-resolution.md](permission-resolution.md) before using them.

Current RPC senders authenticate a versioned request ID, issue time, target
scope, method, and params inside ciphertext. The target requires the inner route
to match the visible outer route, enforces a bounded freshness window, and
durably consumes the request identity before handler dispatch. Raw, stale,
future-dated, mismatched, and reused requests fail closed.

Version 2 RPC responses authenticate the same scope, method, and request ID.
Callers retain the outbound identity and reject captured ciphertext from a
different request, raw legacy results, malformed envelopes, and authenticated
remote errors. Authenticated version 1 request compatibility is target-only and
does not permit a current caller to downgrade.

The remote Agent obtains an omitted or home-relative spawn directory from the
live machine daemon through this request-bound RPC channel. Relay-stored machine
metadata remains display data and cannot choose an effectful spawn path. An
explicit spawn path must be absolute, and a captured home-directory response
cannot satisfy a fresh request.

This provides at-most-once dispatch, not transactional exactly-once execution. A
target crash after identity consumption can leave the caller uncertain whether a
side effect started or completed. Reusing that identity remains blocked to avoid
duplicate execution.

The same at-most-once bias applies to incoming encrypted prompts and file
events. The CLI persists only domain-separated digests in an owner-only ledger
scoped to the session key epoch, fsyncs consumption before provider callbacks,
and rejects replays after process restart. The ledger never makes space by
forgetting accepted work; saturation or invalid local state rejects new work.
There is no automatic empty-ledger recovery for an affected key epoch; retire
that session and create a new one after resolving the local storage problem.

## Network and runtime controls

- Non-loopback clients require HTTPS/WSS. Loopback development can use HTTP.
  CLI and Agent enforce one shared credential-free origin policy before any
  bearer-bearing HTTP or Socket.IO client is created. Authenticated CLI and app
  HTTP calls do not follow redirects.
- Native and CLI attachment transfers accept only the exact configured relay
  origin or an HTTPS endpoint in a fixed public object-storage DNS family.
  External raw PUT destinations, private or link-local targets, hostname
  lookalikes, and redirects fail before bytes or multipart fields are sent.
  Bearer credentials are attached only to exact-origin relay requests. A
  literal loopback URL from a self-hosted relay is rewritten to that already
  selected relay origin rather than contacted on the device.
- New client-selected session UUIDs and attachment object UUIDs use canonical
  lowercase spelling. The relay also enforces case-folded database uniqueness
  and exact local path spelling, so case-insensitive filesystems cannot turn a
  textually distinct tenant identifier into the same attachment object.
- Protected HTTP routes and every Socket.IO connection require authentication.
- Socket authentication consumes and clears the client handshake auth object
  before asynchronous admission, preventing cluster socket queries from
  serializing reusable bearers into an adapter stream.
- Browser origins use an exact allowlist; CORS is not treated as authentication.
- Authentication routes, general HTTP traffic, and Socket.IO connection bursts
  have bounded rate limits keyed from a trusted source address.
- Voice permission callbacks require the exact authenticated session/request
  pair. Arguments stay outside provider context, while the trusted local modal
  shows the complete request without truncation and rechecks the same snapshot
  immediately before approval.
- The bare server binds to loopback by default; containers are intended to be
  published only through an explicit host or platform ingress boundary.
- Required provider containment fails closed when the Idle sandbox cannot start.
  Sandboxed children receive a provider-scoped environment rather than every
  variable held by the daemon. Its automatic policy denies recognized local
  credential stores and browser profiles, limits egress to supported provider
  endpoints, and disables local TCP binding. Unrestricted networking and
  `--no-sandbox` remain explicit user choices.
- Sandboxed Codex receives an empty disposable runtime home and requires
  `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `OPENAI_API_KEY`. Idle bootstraps
  those credentials through supported Codex interfaces, removes them from the
  provider child environment, denies the trusted Codex home to the child, and
  removes bootstrap auth files before prompts. Consumer ChatGPT login stored by
  the official CLI cannot be delegated into this sandbox through a supported
  public interface. A remote launch requires explicit in-app confirmation before
  it uses Codex's native workspace sandbox and normal approval prompts; a direct
  terminal launch requires `idle codex --no-sandbox`. Both paths use the user's
  normal Codex state without Idle's additional read and network containment.
  The choice is recorded with the session and preserved on resume rather than
  silently changing its sandbox boundary.
- Managed native builds can require signed over-the-air bundles. Release signing
  credentials are not part of the public repository. TestFlight release
  automation pins the EAS CLI, requires an exact clean Git commit for each
  archive operation, and independently rejects credential files and
  maintainer-only material from the EAS upload tree.

The managed iOS app's hosted-relay transport policy does not pin a self-hoster's
custom hostname. A custom relay still needs a certificate trusted by the client
platform unless a custom native build deliberately configures another policy.

## Client storage

Native iOS and Android clients use Keychain- and Keystore-backed storage for
account material. The web client keeps its bearer and account secret in memory
only, removes the legacy `localStorage` credential record, and requires account
restore again after a page reload or browser restart. Same-origin JavaScript
can still access credentials while an authenticated page is running, so a
successful script injection or compromised dependency could exfiltrate that
live session. Treat the web client as a different and generally higher-risk
endpoint for sensitive sessions.

Native clients also bind persisted session replay floors and deletion
tombstones to an account-specific epoch and ciphertext digest in device-secure
storage. After that anchor is established, missing, corrupt, mismatched, or
older restored state fails closed and requires signing out and pairing the
device again. Existing unanchored fence data cannot prove its freshness during
upgrade and requires that one-time recovery instead of being migrated. The
browser keeps the same account-bound consistency marker in origin-local
storage, which detects partial or accidental state loss but is not a
rollback-resistant anchor: a coordinated rollback of both browser values cannot
be detected locally. Use a native client when resistance to local state rollback
is required.

Production builds suppress standard console channels before app startup, but
that is defense in depth. Code must still avoid placing decrypted content,
credentials, paths, or identifiers in logs or support artifacts.

## Limits of the model

- Session tags, identifiers, sequence and version counters, timestamps, activity,
  usage, attachment metadata, and message sizes remain visible to the relay.
- A legacy GitHub OAuth credential is not end-to-end encrypted against the
  relay. The current runtime does not expose OAuth initiation or callback
  routes, but operators upgrading an existing database should have users revoke
  retained connections. Compromise of `IDLE_MASTER_SECRET` could forge authentication tokens
  and decrypt a retained GitHub OAuth credential while it remains stored.
- Content intentionally sent to a coding-agent provider, voice provider, push
  provider, analytics service, or connected integration enters that provider's
  boundary.
- Client encryption does not protect plaintext before encryption or after
  decryption on a compromised authorized endpoint.
- Infrastructure can still delay, drop, replay, roll back, or deny access to
  ciphertext outside the ordering, version, freshness, and replay controls that
  clients enforce.
- HTTP response bodies and decoded records have explicit client-side limits.
  With the current browser and native Socket.IO stacks, however, an event frame
  reaches Idle only after the transport library has decoded it; the app cannot
  impose a byte ceiling before that allocation. Relay-side event limits and
  post-delivery schema limits reduce exposure, but a compromised or badly
  configured relay could still cause transient client memory pressure with an
  oversized realtime frame.
- The bounded session inventory is not an authoritative deletion list. Clients
  merge returned records and require an explicit, generation-matched delete
  update rather than treating an omitted session as deleted. This prevents a
  capped or partial snapshot from deleting valid local state, but a missed
  delete can leave a stale session visible until the delete is observed or the
  client is paired again.
- A malicious client can submit invalid ciphertext or misleading metadata. Wire
  schema validation alone does not prove that a trusted key holder encrypted a
  value.
- Idle's documentation and tests are not a substitute for an independent audit
  of a deployment and its operating environment.

## Self-hosting

Self-hosting moves relay-visible metadata, ciphertext, and server-readable
integration data to infrastructure you operate. It does not change the coding
agent, voice, push, analytics, or GitHub provider boundaries.

Protect `IDLE_MASTER_SECRET`, keep the listener behind HTTPS or a private
tailnet, preserve rate limits, restrict metrics and admin interfaces, and back up
the data directory and secret as one recovery set. Follow
[SELF-HOSTING.md](SELF-HOSTING.md) and the
[hardening checklist](deploy-targets/security-hardening.md).

## Report a vulnerability

Use the private contact option in the GitHub issue chooser or email
`hello@northglass.io`. Do not place credentials, account contact details, private
repository names, unredacted logs, or live account, machine, or session
identifiers in a public issue.

## Technical reference

- [Encryption and visibility](encryption.md)
- [HTTP API](api.md)
- [Realtime protocol](protocol.md)
- [Session protocol](session-protocol.md)
