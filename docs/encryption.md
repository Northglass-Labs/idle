# Encryption and visibility boundaries

Idle encrypts coding-session content on authorized clients before relay
transport. This protects selected content fields from a relay or storage reader;
it does not hide routing metadata, every product feature, or data intentionally
sent to an integration.

The client account secret is separate from `IDLE_MASTER_SECRET`. The first is
client key material used to open account content keys. The second belongs to the
relay and cannot derive the client account secret.

## Key roles

| Key | Held by | Purpose |
|---|---|---|
| Client account secret | Authorized app, CLI, or agent clients | Legacy content encryption and deterministic derivation of the account content key pair |
| Per-record data key | Authorized clients | AES-256-GCM encryption for a session, machine, or artifact |
| Session blob key | Authorized clients | NaCl secretbox encryption for attachment bytes, separated from message encryption |
| `IDLE_MASTER_SECRET` | Relay runtime | Issue and verify bearer authentication tokens; protect any legacy server-readable GitHub OAuth token at rest; derive a voice pseudonym |

`IDLE_MASTER_SECRET` does not decrypt client-encrypted session content or client
content keys. Rotating it invalidates relay authentication and any retained
legacy GitHub OAuth credential; it is not a content-key rotation mechanism.

## Current per-record format

New sessions, machines, and artifacts use a random 32-byte data key. Clients
encrypt JSON content with AES-256-GCM:

```text
version 0 (1 byte) | nonce (12 bytes) | ciphertext | authentication tag (16 bytes)
```

The data key is encrypted to the account content public key with an ephemeral
NaCl box key pair:

```text
version 0 (1 byte) |
ephemeral public key (32 bytes) | nonce (24 bytes) | box ciphertext
```

The versioned key bundle is base64 encoded in `dataEncryptionKey`. Only a client
holding the corresponding content private key can recover the data key.

AES-GCM authenticates the ciphertext. A modified value fails decryption instead
of producing partially trusted JSON. Unique random nonces are generated for
each encryption operation.

### Session field coordinate binding

Current session metadata and agent-state producers encrypt a strict plaintext
envelope containing the session ID, field name, field version, and value. The
envelope is protected by the record's authenticated encryption:

```text
idle-session-field v1 | sessionId | metadata or agentState | version | value
```

Clients compare all three relay-visible coordinates (session, field, and
version) with the authenticated inner values before applying a live update. A
captured version-1 ciphertext therefore cannot be moved to another session,
reused as metadata, or relabeled as version 999. New clients choose a random
session ID before creating the record so version-0 metadata and agent state are
bound from the first write.

That initial binding requires a relay version that accepts and preserves the
client-selected session ID. If an older relay substitutes a generated ID, the
current CLI and agent detect that the echoed ciphertext is bound to the wrong
record and stop with an upgrade-required error; they do not return a silently
broken session. The current relay remains compatible with older clients that
create raw legacy fields.

The data-key CLI retains one local session identity for each tag it creates:
the chosen UUID and random data key are sealed under the machine key, while the
filename uses a keyed tag fingerprint. Records are owner-only, written
atomically, and reject symlink or authentication tampering. The identity
remains after a successful response because a later idempotent same-tag request
can return the existing row, and this CLI credential intentionally does not
hold the account content private key needed to unwrap that row by itself. The
raw tag and plaintext data key are not written to the identity store.

Existing raw legacy fields remain readable during an initial full sync. They
are not cached as authenticated values and are not accepted as live state
updates, so legacy ciphertext cannot trigger permission or voice side effects.
The next successful write from a current CLI stores the bound form. A decrypted
object that claims to be a current envelope but has malformed or mismatched
coordinates always fails closed; it is never reinterpreted as legacy data.

## Legacy format

Records without `dataEncryptionKey` use the client account secret with NaCl
secretbox (XSalsa20-Poly1305):

```text
nonce (24 bytes) | authenticated ciphertext
```

Clients retain this reader for existing records. New code must not reinterpret a
failed key unwrap as legacy data: malformed or foreign key bundles fail closed
for that record.

## Attachment encryption

Attachment bytes are encrypted on the client with NaCl secretbox before upload.
For current sessions, the blob key is derived from the session data key under a
separate derivation context; legacy sessions derive a blob key from the client
account secret.

The relay sees the session ID, object reference, requested filename and size,
transfer timing, and encrypted byte length. Local storage receives the
ciphertext directly; an S3-compatible deployment receives or serves the same
ciphertext through presigned operations. Encryption does not make object
retention or access control optional.

## Client-encrypted fields

The implemented clients encrypt these values before relay transport:

- session message content, metadata, and agent state;
- machine metadata and daemon state;
- account settings;
- artifact header and body;
- KV values;
- access-key payloads;
- attachment bytes;
- current session and machine RPC parameters/results.

The relay stores these as opaque strings or bytes. Base64 is only a JSON-safe
encoding and adds no confidentiality.

Typical message storage is:

```json
{
  "t": "encrypted",
  "c": "<base64 authenticated ciphertext>"
}
```

The `t` discriminator asserts a wire shape, not that an untrusted caller used
the correct key. Server ownership checks, schema validation, and successful
client AEAD verification remain separate controls.

Incoming user prompts and file events carry a sender-owned message identity in
their authenticated plaintext. Before invoking a provider callback, the CLI
atomically consumes a digest of that identity in an owner-only durable ledger
scoped to the session and a non-secret digest of its encryption-key epoch.
Identity-less compatibility records use a canonical ciphertext digest. The
ledger contains no prompt text, ciphertext, raw identifiers, credentials, or
keys and is synced before dispatch. It survives process restarts, never evicts
an accepted identity to admit another, and fails closed on replay, corruption,
missing anchored state, or capacity exhaustion.

Because message ciphertext has no authenticated expiry, these consumed markers
do not expire while that session key can still decrypt old messages. A scope is
bounded to 16,384 actionable incoming records; start a new session/key epoch if
that explicit safety bound is reached. Upgrading cannot reconstruct every
identity consumed by an older CLI from an untrusted relay's bounded history, so
new sessions provide the strongest transition boundary after this control is
installed.

## Server-readable data

The relay necessarily processes or retains information outside the client E2E
boundary, including:

- account public keys and account profile fields;
- routing identifiers, record type, sequence/version numbers, and timestamps;
- session and machine activity/presence;
- usage reports containing token and cost counts;
- integration provider names and connection state;
- push tokens plus notification title and body;
- attachment paths, sizes, and transfer metadata;
- voice usage, conversation identifiers, entitlement state, and provider
  responses;
- RPC method and routing identifiers.

The relay treats RPC params as opaque and cannot prove that a caller encrypted
them. Current senders put params inside a strict authenticated request envelope
that also binds a version, unique request ID, issue time, target scope, and
method. The target CLI requires that decrypted envelope and consumes its digest
in a durable replay ledger before dispatch; raw legacy params, expired requests,
route mismatches, and reused identities fail closed. RPC results remain
client-encrypted. Version 2 results also authenticate the original scope,
method, and request ID; callers reject a valid ciphertext replayed from another
request. Targets retain authenticated version 1 request compatibility only for
the explicit migration window and return raw results solely to version 1
callers. New clients do not downgrade. New clients must preserve these
application-layer contracts.

## Legacy server-encrypted GitHub credential

A GitHub OAuth token retained from an earlier deployment is encrypted at rest
under a key tree derived from `IDLE_MASTER_SECRET`. The server can decrypt the GitHub OAuth token
to revoke the provider grant during authenticated disconnect.
This is not end-to-end encryption against the relay. The current runtime
registers no OAuth initiation or callback route and cannot create a new token.

Coding-agent credentials remain in the provider CLI, SDK, or local environment
and are not stored by the relay. Server-funded voice uses server-owned
ElevenLabs credentials and sends voice data into that provider's boundary. Push delivery sends the
server-readable notification payload and device token to the configured push
provider.

## Authentication is a separate protocol

Account authentication uses an endpoint-bound, one-time challenge signed by the
client. Device pairing v3 signs a canonical transcript containing the relay
audience, one-time requester box key, account signing key, bearer, and 32-byte
account secret, then encrypts it to the requester. The requester verifies that
the signing key is derived from the recovered secret and requires the
approver-displayed 48-bit verification code before persistence. The relay
forwards the ciphertext unchanged rather than minting replacement account
credentials. Content encryption does not replace route authentication, account
ownership checks, TLS, rate limits, or the human comparison step.

## Threat boundary

Client encryption is intended to keep protected content opaque to relay
storage, logs, database backups, and object storage. It does not protect against:

- a compromised authorized client or stolen client account secret;
- plaintext before encryption or after decryption on an endpoint;
- metadata analysis using server-readable fields;
- content intentionally placed in push, usage, profile, voice, or provider
  requests;
- a malicious client submitting invalid or misleading ciphertext;
- deletion, replay, rollback, or denial of service by infrastructure outside
  the controls enforced by sequence/version checks.

Native app clients persist their accepted session field floors and deletion
tombstones behind a device-secure, account-bound epoch commitment. Restoring an
older encrypted fence, losing either half, or switching accounts fails closed.
Browser origin storage supplies only a consistency marker; because both browser
values can be rolled back together, it is not equivalent to the native secure
anchor.

## Implementation references

- [CLI cryptography](../packages/idle-cli/src/api/encryption.ts)
- [App encryption coordinator](../packages/idle-app/sources/sync/encryption/encryption.ts)
- [Agent cryptography](../packages/idle-agent/src/encryption.ts)
- [Relay credential encryption](../packages/idle-server/sources/modules/encrypt.ts)
- [Shared wire schemas](../packages/idle-wire/src)
