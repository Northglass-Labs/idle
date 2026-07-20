# Idle 0.4.22 — 2026-07-19

QR pairing is quick and dependable again, even when your camera needs a moment.

- Fixed iPhone scanning so a newly recognized account or terminal QR code is
  delivered immediately instead of waiting for the camera view to change.
- Pairing now stays ready for up to two minutes and closes the scanner cleanly
  when the attempt ends. Fifteen seconds was optimistic, even for a computer.
- A completed first pairing now opens Create Session immediately while initial
  synchronization continues safely in the background.
- Remote Codex launches using a consumer ChatGPT sign-in now explain the
  available sandbox boundary and require confirmation before continuing with
  Codex's native workspace sandbox.
- Corrected the minimum CLI compatibility check for the Idle 0.4.13 release.

# Idle 0.4.21 — 2026-07-16

Security and reliability hardening for safer, more responsive remote sessions.

- Codex sandbox startup now uses supported isolated authentication paths and
  reports clear credential errors without silently broadening permissions.
- Waiting on an archived session now completes promptly, so remote controls do
  not linger on or send work to a session that has already closed.
- Every terminal-pairing path now shows the same requester fingerprint and
  clearly explains the durable account authority being granted.
- Privacy copy now distinguishes encrypted session content from relay-visible
  account, routing, and operational metadata.
- Native update checks now return no destination until an Idle store listing is
  verified, removing invalid or unrelated store redirects.
- TestFlight source identity, EAS credential exclusions, container
  immutability, dependency checks, and upstream-import provenance received
  additional hardening.
- Fixed iOS archive compatibility with the current Expo and React Native
  toolchain.
- Reduced unused web font assets and added strict generated-release checks for
  unintended branding or internal markers.
- Kept dependency package metadata out of release bundles while preserving
  required license attribution.

# Idle 0.4.20 — 2026-07-12

Safer defaults, clearer privacy controls, and more reliable remote sessions.

- Agent approvals now remain on their normal safe defaults unless you
  explicitly select a more powerful mode. Codex `--yolo` and Claude
  `--dangerously-skip-permissions` remain available as deliberate choices.
- Session reconnection, message catch-up, attachment handling, resume, abort,
  and background delivery are more resilient across iOS and web.
- Product analytics is off by default and starts only after versioned,
  explicit consent. Prompts, responses, URLs, relay hostnames, and account or
  session identifiers stay outside the analytics boundary.
- Server-mediated voice now uses a server-owned agent and fails closed when
  usage cannot be verified. Direct bring-your-own-agent voice remains
  available.
- Account deletion, self-hosted relay selection, session grouping, file tools,
  accessible status details, and first-run pairing guidance are easier to find.

# Idle 0.4.0 — 2026-03-19

Expanded remote session control across supported coding agents.

- Added Codex, Gemini, and OpenClaw session support alongside Claude Code.
- Added daemon-backed remote session launch, resume, worktree selection, and
  session quick actions.
- Added model, reasoning-effort, and permission controls that travel with each
  session.
- Improved encrypted synchronization, Markdown rendering, and mobile session
  management.

# Idle 0.3.0 — 2025-08-29

Introduced secure device pairing and connected integrations.

- Added QR and deep-link pairing for mobile, web, and CLI clients.
- Added optional GitHub connection with server-side encrypted token storage.
- Added voice conversations and improved multi-device synchronization.
- Added dark mode and responsive iOS, Android, and web layouts.

# Idle 0.1.0 — 2025-05-12

Initial public release of the encrypted mobile companion for coding agents.

- Added end-to-end encrypted session messages, metadata, and shared files.
- Added real-time relay synchronization between a coding machine and mobile
  clients.
- Added session management, permission requests, and a file browser.
