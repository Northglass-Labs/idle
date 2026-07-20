# `idle-coder`

`idle` runs local coding agents while an authenticated Idle app or browser
controls the session remotely.

## Install

Node.js 22.12 or newer is required.

```bash
npm install -g idle-coder
idle --help
```

Install and authenticate the provider CLI you intend to run.

## Start an agent

```bash
idle                 # Claude Code
idle claude
idle codex
idle gemini
idle openclaw
idle acp opencode
idle acp -- custom-agent --flag
```

Idle starts or reuses its machine daemon, authenticates the local client, creates
an encrypted session record, and prints a QR or browser pairing path when
needed.

## Permission modes

The default path keeps agent approval prompts enabled. A remote app can select a
supported mode for a turn, and provider-specific adapters map that mode to the
underlying agent.

```bash
idle --yolo
```

`--yolo` is an explicit dangerous approval bypass. For Claude it forwards
`--dangerously-skip-permissions`; other adapters select their corresponding
bypass policy. It is not the default. Sandbox configuration is a separate
control and does not silently enable `yolo`.

The Idle OS sandbox is enabled by default for Claude (local and SDK modes),
Codex, Gemini, and generic ACP processes. A required sandbox fails closed before
the provider starts. The per-session opt-out is explicit:

```bash
idle --no-sandbox
idle codex --no-sandbox
idle gemini --no-sandbox
idle acp --no-sandbox opencode
idle acp --no-sandbox -- custom-agent --flag
```

When containment is enabled, provider children receive a provider-scoped
environment instead of every variable held by the long-lived Idle daemon. Idle
credential, control, settings, session-key, common CLI credential-store, and
browser-profile paths are denied to the provider process. The automatic network
policy permits supported provider endpoints, blocks other egress, and disables
local TCP binding. `idle sandbox configure` can select a stricter policy or an
explicit unrestricted network mode. For Claude, Gemini, and generic ACP, the
opt-out restores the provider's normal host environment for compatibility. It
should be treated as a reduction in containment.

Sandboxed Codex uses an empty, owner-only, disposable `CODEX_HOME`. The trusted
Idle parent can bootstrap `CODEX_ACCESS_TOKEN` with the official
`codex login --with-access-token` command or provide `CODEX_API_KEY` /
`OPENAI_API_KEY` to the app-server login RPC. Credentials are removed from the
provider child environment, the user's normal Codex home is denied to the
child, and disposable bootstrap files are deleted before a turn can start.

The official Codex CLI's consumer ChatGPT login may be held in the OS keyring.
Codex does not expose a supported public interface for delegating that login
into Idle's isolated runtime. A remote app launch detects that condition and
requires an explicit confirmation before using Codex's native workspace
sandbox and normal approval prompts. A direct terminal launch requires the
equivalent explicit choice with `idle codex --no-sandbox`. This compatibility
mode uses the normal Codex home and consumer login, so the user's Codex
configuration, hooks, skills, history, transcripts, and credential-store access
are no longer separated by Idle's additional sandbox. The selected boundary is
recorded with the session and retained when that Codex thread is resumed.

## Common commands

```bash
idle auth login
idle auth status
idle auth logout

idle daemon start
idle daemon stop
idle daemon status
idle daemon list

idle resume <session-id>
idle notify
idle doctor
idle doctor clean

idle sandbox configure
idle sandbox status
idle sandbox disable

idle server
```

`idle server` runs the packaged PGlite relay locally, generates a single-link
owner-only secret file on first use, and gives the relay only that validated
file path—not a plaintext secret environment value. The CLI discards inherited
master-secret variables and asks before changing its default server setting. It
binds to loopback unless another host is explicitly selected.

## Authentication and provider credentials

Client signing and content private keys stay in the local Idle credential store.
Session messages and selected session/machine state are encrypted before relay
transport. Routing identifiers, timestamps, activity, usage, profile, push,
voice, and integration metadata remain server-readable.

```bash
idle connect gemini
```

Provider credentials remain local under the official Claude Code, Codex CLI,
or Gemini CLI credential store. Idle does not upload those login tokens to the
relay. `idle connect gemini` prints local sign-in guidance; Claude Code and
Codex use their own local sign-in commands.

See [Encryption](../../docs/encryption.md) and
[Security](../../docs/SECURITY.md) before choosing a hosted or self-hosted
security boundary.

## Environment

| Variable | Purpose |
|---|---|
| `IDLE_SERVER_URL` | Override the relay with an exact credential-free HTTP(S) origin |
| `IDLE_WEBAPP_URL` | Override the web-app URL opened for authentication |
| `IDLE_HOME_DIR` | Override the Idle data and credential directory |
| `IDLE_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `IDLE_EXPERIMENTAL` | Enable experimental client features |

Remote relay origins require HTTPS. Plain HTTP is accepted only for loopback
development (`localhost`, `*.localhost`, `127.0.0.0/8`, or `[::1]`). The CLI
canonicalizes this origin before creating HTTP or Socket.IO clients and does
not follow redirects on account-bearer HTTP requests.

Attachment PUT and authenticated download URLs must match that exact relay
origin. Presigned POST uploads and downloads may instead use HTTPS endpoints in
the supported public object-storage DNS families. Arbitrary external hosts,
private or link-local destinations, external raw PUT URLs, hostname
lookalikes, credentials in URLs, non-default ports, fragments, and redirects
are rejected before bytes are transferred. Idle bearer credentials are never
sent to object storage.

## Build from source

```bash
git clone https://github.com/Northglass-Labs/idle.git
cd idle
yarn install --frozen-lockfile
yarn workspace @northglass/idle-wire build
yarn workspace idle-coder build
yarn workspace idle-coder test:unit
```

## License

MIT
