<p align="center">
  <a href="https://idle.northglass.io">Web app</a> ·
  <a href="https://northglass.io">a Northglass Product</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://github.com/Northglass-Labs/idle/issues">Issues</a>
</p>

# Idle

Idle is an open-source remote control for coding agents. Start Claude Code,
OpenAI Codex, Google Gemini, OpenClaw, or an ACP-compatible agent on your
computer; then monitor the session, send messages, and respond to permission
requests from iOS or the web.

Idle encrypts session content on the client before it reaches the relay. The
relay still sees routing metadata, timing, sizes, opaque account and session
identifiers, and unencrypted session tags. Some optional integrations have
different boundaries. Read the [security model](docs/SECURITY.md) and
[privacy notice](PRIVACY.md) before using Idle for sensitive work.

The project is under active development. The web app is available at
[idle.northglass.io](https://idle.northglass.io); iOS is distributed through a
TestFlight beta.

## Quick start

Install the CLI:

```bash
npm install -g idle-coder
```

Start an agent:

```bash
idle          # Claude Code
idle codex    # OpenAI Codex
idle gemini   # Google Gemini
idle openclaw # OpenClaw
```

Open Idle on iOS or the web and follow the pairing prompt printed by the CLI.
Terminal pairing grants durable account authority, including the ability to
create, change, and delete account-owned data. The approval prompt shows the
requesting key fingerprint. Approve only a request you just initiated on a
computer you control; Northglass support will never ask you to approve one.

When linking another app or `idle-agent`, the approving app displays a
verification code. Enter that code on the new device before it saves access;
cancel and restart with a new QR code if it is missing or differs.

## Safe defaults and powerful modes

Idle's safe default preserves the selected agent's normal approval behavior.
Sandbox configuration and permission approval are separate controls; enabling
one does not silently weaken the other.

The local OS sandbox is enabled by default for supported provider processes and
fails closed if required containment cannot be prepared. It also prevents the
agent from inheriting unrelated daemon secrets. `--no-sandbox` is an explicit
per-session compatibility opt-out.

Sandboxed Codex requires `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or
`OPENAI_API_KEY`. Idle bootstraps those credentials into a disposable Codex
home, keeps them out of the model subprocess environment, and removes bootstrap
files before a turn. A consumer ChatGPT login held by the official Codex CLI
cannot be delegated into that isolated sandbox through a supported public
interface. For a remote launch, the app detects that condition and asks before
using Codex's native workspace sandbox and normal approval prompts. Idle's
additional read and network restrictions do not apply after approval. A direct
terminal launch requires the equivalent explicit choice with
`idle codex --no-sandbox`; it uses the official CLI's normal Codex home and
consumer login.

Explicit high-power modes remain part of the product. `--yolo` is shorthand
for an agent-specific approval bypass, and Claude also supports the explicit
`--dangerously-skip-permissions` compatibility flag. These modes can allow an
agent to execute commands and change files without individual approval. Use
them only when you intentionally accept that risk. The full resolution rules
are documented in [permission-resolution.md](docs/permission-resolution.md).

## Supported agents

| Agent | Command |
|---|---|
| Claude Code | `idle` or `idle claude` |
| OpenAI Codex | `idle codex` |
| Google Gemini | `idle gemini` |
| OpenClaw | `idle openclaw` |
| ACP-compatible agent | `idle acp <agent-name>` or `idle acp -- <command> [args]` |

ACP support is experimental. The provider CLI or SDK runs on your computer and
remains subject to that provider's authentication, terms, permissions, and data
handling.

## Privacy and integrations

- Session messages, encrypted metadata, and shared file contents are encrypted
  before relay transport. Session tags and operational metadata are not.
- Product analytics is off by default. PostHog initializes only when a build is
  configured for it and the user has given versioned, explicit consent.
- Voice is optional and uses ElevenLabs when configured. Server-mediated voice
  uses a server-owned key and agent; direct mode connects only to a custom
  ElevenLabs agent selected by the user.
- Earlier deployments may retain a connected GitHub OAuth token encrypted at
  rest. It is relay-decryptable, not end-to-end encrypted. The current runtime
  exposes no OAuth initiation or callback route; authenticated users can revoke
  and remove a legacy connection. Coding-agent credentials remain with the
  provider CLI or SDK and are not stored by the relay.
- Push notification title and body are server-readable and may be sent to the
  configured push provider. They must not contain transcript content or secrets.
- Native clients store account material in platform secure storage. Web storage
  is accessible to same-origin JavaScript and therefore has a higher exposure
  if the web origin is compromised.

See [PRIVACY.md](PRIVACY.md) for the short repository notice and the canonical
[Northglass privacy policy](https://northglass.io/privacy) for hosted services.

## Self-hosting

The canonical relay image includes the Node.js server, embedded PGlite storage,
local attachment storage, and migrations. External PostgreSQL, Redis, and S3
are optional rather than required. The web client has a separate unprivileged
static image.

Start with [SELF-HOSTING.md](docs/SELF-HOSTING.md) for Docker Compose, a VPS,
Tailscale, and supported managed-platform examples. Self-hosting moves relay
metadata and ciphertext to infrastructure you control; it does not remove the
data boundaries of provider CLIs or optional integrations.

## Repository map

| Path | Public component |
|---|---|
| [`packages/idle-app`](packages/idle-app/README.md) | Expo iOS, Android, and web client |
| [`packages/idle-cli`](packages/idle-cli/README.md) | `idle-coder` CLI and local daemon |
| [`packages/idle-agent`](packages/idle-agent/README.md) | Programmatic remote-control CLI |
| [`packages/idle-server`](packages/idle-server/README.md) | Fastify and Socket.IO relay |
| [`packages/idle-wire`](packages/idle-wire/README.md) | Shared Zod schemas and wire types |
| [`packages/idle-e2e`](packages/idle-e2e/README.md) | Browser end-to-end tests |
| [`packages/idle-e2e-mobile`](packages/idle-e2e-mobile/README.md) | iOS simulator end-to-end tests |

Architecture, protocol, API, encryption, deployment, and contribution guides
are indexed in [docs/README.md](docs/README.md).

## Development and verification

Idle development uses Node.js 22.12 or newer and Yarn Classic 1.22.

```bash
yarn install --frozen-lockfile
yarn test
yarn typecheck
```

The public release gates also verify package contents, clean and immutable EAS
source, container defaults, public documentation, secret hygiene, and
source-bound reviewed upstream imports. Web and mobile end-to-end instructions
live in their package READMEs.
See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full local workflow.

## Security reports

Do not place credentials, private repository names, unredacted logs, or live
session identifiers in a public issue. Follow [docs/SECURITY.md](docs/SECURITY.md)
and report sensitive findings to `hello@northglass.io`.

## Upstream and license

Idle incorporates work from [Happy](https://github.com/slopus/happy). Attribution
and license notices are preserved while product branding, infrastructure, and
configuration remain separate. Reviewed imports use the fetch-only workflow in
[UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md).

Idle is available under the [MIT License](LICENSE).
