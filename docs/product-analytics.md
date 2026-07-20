# Optional product analytics

Idle ships with product analytics disabled for new users. The app does not
construct an analytics client or contact the analytics service until a user
explicitly enables analytics in Settings. A deployment can disable analytics
entirely, even when a stored user preference would otherwise enable it.
Consent is tied to the current analytics disclosure version. A legacy stored
value without that marker is treated as opted out, and a local opt-out made
during settings synchronization takes precedence over a stale server value.

Idle currently uses PostHog when analytics is enabled. Session replay, surveys,
automatic lifecycle capture, automatic URL capture, exception/console
autocapture, feature-flag evaluation events, and default person properties are
disabled. In particular, initial URLs are never captured because they can
contain one-time pairing material.

## Identity and provider metadata

Idle does not derive or send an analytics identifier from the account secret
and does not call PostHog's identify API. After opt-in, the SDK assigns its own
pseudonymous device identifier and analytics-session identifier. Person-profile
processing is disabled. Logging out resets the SDK identifiers; reinstalling
the app also replaces local SDK state. Provider identifiers are not an email
address, name, GitHub identity, relay account ID, coding-session ID, or machine
ID.

The analytics SDK adds the protocol fields it needs to deliver an event,
including library/version fields, screen dimensions, and its pseudonymous
device/session identifiers. Idle limits custom app and device properties to app
build/version, device class, OS name, and OS version. The provider necessarily
records event receipt time and network-layer metadata under its own service
controls.

## Allowed events

Events without a listed property carry no application-defined properties.

| Area | Event | Allowed application-defined properties |
| --- | --- | --- |
| Authentication | `account_created`, `account_restored` | none |
| Connection | `connect_attempt` | none |
| Sessions | `session_switched` | none |
| Messages | `message_sent` | enumerated source, agent family, CLI/daemon origin, CLI version, OTA version/runtime |
| Voice | `voice_recording` | start/stop action |
| Voice | `permission_response`, `voice_permission_response` | boolean result |
| Voice | `voice_session_started` | subscription flag and bounded aggregate counters |
| Voice | `voice_session_error` | none |
| Voice | `voice_session_stopped` | optional bounded duration |
| Purchases | `paywall_*` | optional fixed flow name; errors are discarded |
| Reviews | `review_*` | boolean response or bounded retry interval where applicable |
| Updates | `ota_update_available`, `ota_update_applied` | OTA version/runtime |
| Other | `whats_new_clicked`, `github_connected` | none |
| Navigation | screen event | first non-group route category only |

The source-of-truth allowlist and property shaping live in
`packages/idle-app/sources/track/index.ts`,
`packages/idle-app/sources/track/tracking.ts`, and
`packages/idle-app/sources/track/useTrackScreens.ts`.

## Data that analytics must never receive

- prompts, responses, tool calls, terminal output, file contents, attachments,
  voice transcripts, or other session content;
- URLs, deep links, pairing payloads, filesystem paths, working directories,
  repository names, or hostnames;
- names, email addresses, account/profile fields, GitHub profile data, or
  provider account data;
- Idle relay account, machine, coding-session, message, voice-conversation,
  request, or thread identifiers;
- access tokens, API keys, credentials, encryption keys, or secrets;
- raw exception messages or stacks; and
- exact session creation/activity timestamps supplied by the app.

Adding an event or property requires updating the allowlist, its privacy tests,
and this document in the same change.

## Disabling analytics

Users can disable analytics in Settings at any time. Disabling it opts out the
existing client, releases the in-memory client reference, and prevents future
captures. Logging out also resets the provider's device identifier and disables
the client. Self-hosted and managed builds can force analytics off with the
documented deployment configuration.
