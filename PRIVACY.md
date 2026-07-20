# Idle Privacy Notice

Last updated: July 13, 2026

The canonical privacy policy for the Northglass-hosted Idle service is
[northglass.io/privacy](https://northglass.io/privacy). That policy describes
the operator, purposes, service providers, retention, choices, and contact
process. This repository document is a technical summary, not a replacement for
the canonical policy.

## Technical Data Boundary

- Prompts, responses, shared file contents, session titles, summaries, and agent
  state are encrypted on the client before relay storage. The relay stores and
  routes their ciphertext without the session content keys.
- Routing metadata is not end-to-end encrypted. The relay can process opaque
  account, session, message, device, and machine identifiers; timestamps;
  sequence numbers; session tags; encrypted payload sizes; and ordinary network
  request metadata.
- A legacy GitHub OAuth token retained by an earlier deployment is encrypted at
  rest with a server-held key. The server can decrypt it for provider revocation
  during authenticated disconnect; the current runtime cannot create a new
  link. It does not share the end-to-end boundary of session content.
  Coding-agent credentials stay with the provider CLI or SDK on the user's
  computer and are not stored by the relay.
- Push delivery requires a device push token processed by the hosted relay and
  the applicable Apple or Expo delivery service. Idle does not put prompt or
  response text in the push payload.

## Optional Services

- Product analytics is off by default. If a user explicitly opts in, Idle sends
  a limited set of product events and app or device context to PostHog. The
  event boundary excludes prompts, responses, session content, URLs, relay
  hostnames, and account or session identifiers.
- Subscription features use RevenueCat and the applicable app store.
- While voice is active, Idle sends microphone audio to ElevenLabs. To preserve
  multi-session control, it also sends active-session titles and summaries,
  current and relevant background-session transcript updates, opaque session
  and request identifiers, and permission tool names. Idle does not separately
  forward stored project paths or permission arguments. Transcript text can
  itself contain sensitive data. This boundary applies to both
  server-mediated and direct mode. Direct mode accepts a custom ElevenLabs Agent
  ID; the app does not accept or store an ElevenLabs API key.
- Coding-agent and repository integrations send data to the provider the user
  chooses, subject to that provider's own terms and privacy policy.

Self-hosted operators control their own deployment and are responsible for its
privacy, retention, access, and subprocessors. For implementation details and
limitations, see [docs/SECURITY.md](docs/SECURITY.md). Privacy questions and
requests should be sent to `hello@northglass.io`, not posted in a public issue.
