# Idle documentation

Idle is an open-source remote control for coding agents with iOS, Android, and
web clients. The [root README](../README.md) has the shortest path to a working
session.

## Start here

- [CLI guide](../packages/idle-cli/README.md) — install `idle-coder`, start an
  agent, and understand permission modes.
- [Security model](SECURITY.md) — what clients encrypt, what the relay can read,
  and where integrations create different boundaries.
- [Self-hosting](SELF-HOSTING.md) — run a relay locally, on a private network, or
  behind HTTPS.
- [Contributing](CONTRIBUTING.md) — set up a clean development environment and
  run the verification suites.

## Components

| Component | Guide |
|---|---|
| iOS, Android, and web app | [`packages/idle-app`](../packages/idle-app/README.md) |
| Interactive CLI and daemon | [`packages/idle-cli`](../packages/idle-cli/README.md) |
| Programmatic control client | [`packages/idle-agent`](../packages/idle-agent/README.md) |
| Relay server | [`packages/idle-server`](../packages/idle-server/README.md) |
| Shared schemas and wire types | [`packages/idle-wire`](../packages/idle-wire/README.md) |
| Browser end-to-end tests | [`packages/idle-e2e`](../packages/idle-e2e/README.md) |
| Mobile end-to-end tests | [`packages/idle-e2e-mobile`](../packages/idle-e2e-mobile/README.md) |

## Technical reference

- [System architecture](ARCHITECTURE.md), [CLI architecture](cli-architecture.md),
  and [backend architecture](backend-architecture.md)
- [HTTP API](api.md), [realtime protocol](protocol.md), and
  [realtime sync and RPC](realtime-sync-and-rpc.md)
- [Encryption boundaries](encryption.md), [session protocol](session-protocol.md),
  and [Claude adapter mapping](session-protocol-claude.md)
- [Permission resolution](permission-resolution.md) and
  [voice architecture](voice-architecture.md)

## Operations and project policy

- [Deployment targets](deploy-targets/), [security hardening](deploy-targets/security-hardening.md),
  and [monitoring](monitoring.md)
- [Optional product analytics](product-analytics.md)
- [Product direction](ROADMAP.md)
- [Reviewed upstream imports](UPSTREAM-SYNC.md)

The implementation is authoritative for executable behavior. Public docs must
describe current interfaces without production topology, private operations,
personal data, assessment notes, or maintainer-only chronology.
