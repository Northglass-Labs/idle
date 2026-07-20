# Idle Product Direction

Idle's public direction is deliberately stable and non-dated. It describes the
product boundary, not a release schedule.

## Secure remote control

- Keep normal agent approvals as the default while retaining explicit,
  well-labeled powerful modes for users who choose them.
- Make runtime security claims observable and testable across the client, CLI,
  relay, and supported coding agents.
- Continue reducing relay-visible data and make every optional processor clear.

## Reliable clients and protocol

- Maintain first-class iOS and web clients backed by a documented, versioned
  wire protocol.
- Improve reconnection, sync, file transfer, session management, and accessible
  voice control without weakening encryption or permission boundaries.
- Keep the CLI, relay, wire library, and programmatic agent package independently
  testable and usable by self-hosters.

## Open ecosystem

- Support multiple coding agents through explicit compatibility layers.
- Preserve a reproducible, attribution-safe upstream synchronization process.
- Publish stable interfaces and migration guidance before changing public
  packages or protocol behavior.

This direction is not a release commitment. Completed user-visible work is
summarized in the app changelog.
