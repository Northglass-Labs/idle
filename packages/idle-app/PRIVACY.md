# Idle Privacy Notice

Last updated: July 12, 2026

The canonical privacy policy for the Northglass-hosted Idle service is
[northglass.io/privacy](https://northglass.io/privacy). It describes the
operator, purposes, service providers, retention, choices, and contact process.

Idle encrypts prompts, responses, shared files, session titles, summaries, and
agent state on the client before relay storage. The relay still processes the
routing metadata needed to operate the service, including opaque account,
session, device, machine, and message identifiers; timestamps; sequence
numbers; session tags; encrypted payload sizes; push tokens; and ordinary
network request metadata.

A legacy GitHub credential retained by an earlier deployment is encrypted at
rest with a server-held key and can be decrypted for provider revocation during
authenticated disconnect. The current runtime cannot create a new link.
Optional product analytics is off by default and requires explicit consent.
Subscription, push, voice, repository, and coding-agent features use the third
parties identified in the canonical policy when the user enables or invokes
those features.

For the implementation boundary and known limitations, see the repository's
[`docs/SECURITY.md`](../../docs/SECURITY.md). Privacy questions and requests
should be sent to `hello@northglass.io`, not posted in a public issue.
