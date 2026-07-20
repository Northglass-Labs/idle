# `@northglass/idle-wire`

Shared Zod schemas and TypeScript types for Idle clients, agents, and the relay.
The package publishes CommonJS, ESM, and declaration entrypoints from `dist/`.

Node.js 22.12 or newer is required for repository development.

```bash
npm install @northglass/idle-wire
```

## Boundary

These schemas validate structure. They do not perform encryption,
authentication, authorization, or transport security. A value matching
`SessionMessageContentSchema` has an encrypted-container shape; only successful
client AEAD verification establishes that its bytes were produced by a trusted
key holder.

Voice response schemas contain server/provider credentials and usage data, not
session ciphertext. `AuthPairingPayloadSchema` describes the legacy terminal
pairing payload that the relay encrypts to the requesting client's public key.
Terminal pairing can include a separate `rpcRegistrationToken`; callers must
keep it distinct from the ordinary API bearer. Account linking uses the
separate `AccountPairingPayloadSchema`: the approving client signs the complete
relay-, requester-, account-, bearer-, and secret-bound transcript before
encrypting it to the requester.

## Exported modules

The root entrypoint re-exports:

| Source | Contract |
|---|---|
| `src/messages.ts` | Encrypted message containers, core durable update envelopes, versioned encrypted values |
| `src/sessionFieldEnvelope.ts` | Authenticated session, field, and version binding for metadata and agent state plaintext |
| `src/sessionRecord.ts` | Bounded encrypted session records and create-response validation |
| `src/messageIdentity.ts` | Versioned session/message identity embedded inside authenticated plaintext |
| `src/messageTransport.ts` | Shared encoded-body ceiling and order-preserving message upload batching |
| `src/rpcProtocol.ts` | Versioned request identity, freshness, scope, method, and opaque params inside authenticated RPC plaintext |
| `src/serverUrlPolicy.ts` | Shared HTTPS-or-loopback origin policy for credential-bearing Node clients |
| `src/legacyProtocol.ts` | Decrypted legacy user/agent message shapes |
| `src/sessionProtocol.ts` | Structured decrypted session-event envelopes and `createEnvelope()` |
| `src/voice.ts` | Voice conversation, usage, compatibility token, and structured error responses |
| `src/authProtocol.ts` | Pairing payload encoding and endpoint-bound authentication challenge bytes |

### Core update contracts

- `SessionMessageContentSchema` — `{ t: 'encrypted', c: string }`.
- `SessionMessageSchema` — stored message identity, order, ciphertext container,
  and timestamps.
- `CoreUpdateContainerSchema` — `id`, account sequence, typed body, and creation
  time for the shared core update variants.
- `VersionedEncryptedValueSchema` and
  `VersionedNullableEncryptedValueSchema` — nonnegative version plus opaque
  value.
- `UpdateNewMessageBodySchema`, `UpdateSessionBodySchema`, and
  `UpdateMachineBodySchema` — shared persistent body variants.
- `SessionRecordSchema` and `CreateSessionResponseSchema` — bounded relay
  responses validated before clients unwrap keys or decrypt fields.

Compatibility aliases such as `ApiMessageSchema` and `UpdateSchema` remain
exports. New code should prefer the descriptive core names.

### Decrypted message contracts

- `LegacyMessageContentSchema` validates legacy `user` and `agent` messages.
- `sessionEnvelopeSchema` validates structured session events.
- `createEnvelope()` creates and validates an envelope with generated defaults.
- `MessageContentSchema` accepts legacy and structured session messages after
  decryption.
- `AuthenticatedMessageIdentitySchema` binds the sender's session and message
  identifiers inside encrypted plaintext so receivers can reject relay-rewrapped
  ciphertext. Coding-session receivers combine this identity with a durable,
  key-epoch-scoped consumed-message ledger to detect replay across restarts.
- `AuthenticatedRpcRequestSchema` binds current RPC scope, method, unique request
  identity, issue time, and params inside authenticated plaintext.
- `AuthenticatedRpcResponseSchema` binds a version 2 result or stable error code
  to the exact request scope, method, and request ID. Callers must reject a
  response whose authenticated identity differs from the request they sent.
- `AuthenticatedSessionFieldEnvelopeSchema` binds decrypted session metadata or
  agent state to its relay-visible session ID, field name, and version.
  `createAuthenticatedSessionFieldEnvelope()` builds the strict envelope;
  `readAuthenticatedSessionFieldEnvelope()` returns its value only when all
  expected coordinates match.
- `MessageMetaSchema` carries optional model, permission, tool, and display
  metadata inside the encrypted message payload.

### Voice contracts

- `VoiceConversationResponseSchema`
- `VoiceUsageResponseSchema`
- `VoiceTokenResponseSchema`
- `VoiceTokenErrorSchema`

### Authentication contracts

- `AuthPairingPayloadSchema`
- `encodeAuthPairingPayload()` and `decodeAuthPairingPayload()`
- `buildAuthChallengeMessage`
- `AccountPairingPayloadSchema`
- `buildAccountPairingMessage()`
- `encodeAccountPairingPayload()` and `decodeAccountPairingPayload()`
- `formatAccountPairingCode()`

The challenge helper returns the exact bytes clients sign and the relay verifies.
Changing its prefix or field order is a breaking authentication change.
The account-pairing helper returns the canonical v3 transcript bytes signed by
the approving account. The verification-code helper projects 48 signature bits
for an out-of-band human comparison; it does not replace signature verification.

### Credential transport policy

`normalizeServerUrl()` accepts a bounded credential-free HTTPS origin, plus
plain HTTP only for loopback development. Idle CLI and Idle Agent use this same
implementation so a configured bearer cannot be sent to cleartext LAN or
public origins.

## Usage

```ts
import {
  CoreUpdateContainerSchema,
  SessionMessageContentSchema,
  sessionEnvelopeSchema,
} from '@northglass/idle-wire';

const update = CoreUpdateContainerSchema.safeParse(input);
if (!update.success) {
  throw new Error('invalid update envelope');
}

const ciphertext = SessionMessageContentSchema.parse(update.data.body);
// Decrypt ciphertext.c with the record key in the client crypto layer.

const envelope = sessionEnvelopeSchema.safeParse(decryptedPayload);
```

## Compatibility rules

- Treat discriminator strings and challenge bytes as public protocol API.
- Current RPC receivers require `AuthenticatedRpcRequestSchema`; do not send
  raw decrypted params or reuse a request identity.
- New RPC callers send version 2 requests and require version 2 correlated
  responses. Targets temporarily accept authenticated version 1 requests and
  return their legacy raw response only to those version 1 callers; never
  downgrade a version 2 request after an invalid response.
- Current session-field writers use `AuthenticatedSessionFieldEnvelopeSchema`;
  readers must reject a valid ciphertext moved to another session, field, or
  version.
- Prefer optional/additive fields for mixed-version clients.
- Keep versions nonnegative and monotonic; deletion sentinels belong only to
  contracts that explicitly define them.
- Validate at trust boundaries, then narrow inferred TypeScript types.
- Build and test Wire before dependent workspaces in a clean checkout.

## Development

```bash
yarn workspace @northglass/idle-wire build
yarn workspace @northglass/idle-wire test
```

## License

MIT
