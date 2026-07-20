# Contributing to Idle

Idle welcomes focused bug fixes, accessibility improvements, documentation, and
well-tested product changes. Discuss changes to encryption, authentication,
realtime sync, RPC, or public protocol compatibility in an issue before starting
a large implementation.

Use [GitHub issues](https://github.com/Northglass-Labs/idle/issues) for
reproducible bugs and scoped feature requests. Send sensitive security reports
through the private path in [SECURITY.md](SECURITY.md).

## Before you share evidence

Logs, screenshots, traces, and test artifacts can contain credentials, personal
details, private project content, absolute paths, and account, machine, or
session identifiers. Remove those values before attaching evidence to a public
issue or pull request. Do not use a production account or hosted production relay
for development.

## Requirements

- Node.js 22.12 or newer
- Yarn Classic 1.22
- Git
- Xcode for iOS development, or Android Studio for Android development

## Set up the repository

```bash
git clone https://github.com/Northglass-Labs/idle.git
cd idle
yarn install --frozen-lockfile
yarn workspace @northglass/idle-wire build
```

Idle is a Yarn workspace. Shared wire types must build before the packages that
import them.

## Use an isolated local environment

The environment manager gives each development environment separate relay data,
ports, client state, and credentials:

```bash
yarn env:new
yarn env:server
```

In separate terminals, run the web app and CLI for the selected environment:

```bash
yarn env:web
yarn env:cli
```

Useful commands:

| Command | Purpose |
|---|---|
| `yarn env:list` | List validated local environments |
| `yarn env:use <name>` | Select an environment |
| `yarn env:server` | Run its relay |
| `yarn env:web` | Run its web client |
| `yarn env:cli -- <args>` | Run `idle` with additional arguments |
| `yarn env:down` | Stop its managed processes |
| `yarn env:remove <name>` | Remove a stopped environment |
| `yarn env:tailscale` | Share the selected environment through Tailscale Serve |

Managed environment state lives under the ignored `environments/data/` tree.
The manager restricts local state permissions and does not pass arbitrary parent
environment variables into the server, CLI, or coding agent. A specifically
needed client variable can be granted with `IDLE_ENV_PASSTHROUGH=<NAME>`; treat
that as access for the CLI, daemon, and launched agent.

## Workspace map

| Workspace | Package | Purpose |
|---|---|---|
| `packages/idle-app` | private | Expo iOS, Android, and web client |
| `packages/idle-cli` | `idle-coder` | Interactive CLI and local daemon |
| `packages/idle-agent` | `@northglass/agent` | Programmatic control client |
| `packages/idle-server` | `@northglass/idle-server` | Fastify and Socket.IO relay |
| `packages/idle-wire` | `@northglass/idle-wire` | Shared Zod schemas and wire types |
| `packages/idle-e2e` | private | Browser and API end-to-end tests |
| `packages/idle-e2e-mobile` | private | Native iOS end-to-end tests |

Each workspace README contains its supported commands and security boundary.

## Common development commands

App:

```bash
yarn workspace idle-app start
yarn workspace idle-app web
yarn workspace idle-app ios:dev
yarn workspace idle-app android:dev
yarn workspace idle-app typecheck
```

CLI:

```bash
yarn workspace idle-coder build
yarn workspace idle-coder dev
```

Relay:

```bash
(
  cleanup() { stty echo 2>/dev/null || true; unset IDLE_MASTER_SECRET; }
  trap cleanup EXIT
  printf 'Idle master secret (64 hex characters): ' >&2
  stty -echo
  IFS= read -r IDLE_MASTER_SECRET
  stty echo
  printf '\n' >&2
  export IDLE_MASTER_SECRET
  export IDLE_AUTH_AUDIENCE=http://localhost:3005
  yarn workspace @northglass/idle-server standalone:dev
)
```

The standalone development relay uses PGlite in the clean checkout and never
loads a dot-env file. The subshell reads the required secret without echo and
unsets it on exit. Prefer `yarn env:server` when testing cross-package behavior
so credentials and state remain isolated.

## Verification

Run the complete core suite and type checks from the repository root:

```bash
yarn test
yarn typecheck
```

Run one workspace when iterating:

```bash
yarn workspace @northglass/idle-wire test
yarn workspace idle-coder test:unit
yarn workspace @northglass/idle-server test
yarn workspace @northglass/agent test
yarn workspace idle-app test --run
```

Browser end-to-end tests require an explicitly selected disposable relay; follow
[`packages/idle-e2e/README.md`](../packages/idle-e2e/README.md). Native iOS tests
use Maestro; follow
[`packages/idle-e2e-mobile/README.md`](../packages/idle-e2e-mobile/README.md).

Before reporting a change as complete, run the tests that exercise the changed
boundary and verify the behavior end to end when practical.

## Pull requests

- Lead with a concise statement of the problem and outcome.
- Keep one behavior change or cleanup theme per pull request.
- Add or update a regression test before fixing a bug.
- Include redacted runtime evidence for user-visible changes.
- Keep documentation aligned with behavior.
- Address review feedback and required checks. Never bypass repository hooks or
  security gates.
- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, and `chore:`.

## Public documentation boundary

The repository root, `docs/`, package READMEs, fixtures, and examples are public.
Do not add production topology, credentials, personal data, private repository
names, dated assessment evidence, incident notes, release handoffs, or
maintainer-tool configuration. `scripts/check-docs-hygiene.sh` enforces this
boundary.

Architecture and protocol documentation should describe current interfaces and
trust boundaries. Put implementation details in the narrowest relevant reference
and link to source instead of duplicating it across several guides.

## Upstream changes

Idle incorporates selected work from an attributed upstream project. Do not
merge an upstream branch or copy its branding, signing configuration,
infrastructure, or artwork. Follow the fetch-only, staged-review process in
[UPSTREAM-SYNC.md](UPSTREAM-SYNC.md).

## Community

- [Idle issues](https://github.com/Northglass-Labs/idle/issues)
- [Northglass](https://northglass.io)
