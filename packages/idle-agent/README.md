# `@northglass/agent`

`idle-agent` is a non-interactive control client for authenticated Idle accounts.
It lists encrypted session/machine records, sends messages, monitors state, and
asks an online machine daemon to spawn, resume, or stop coding-agent sessions.

## Install

Node.js 22.12 or newer is required.

```bash
npm install -g @northglass/agent
idle-agent --help
```

## Authenticate

```bash
idle-agent auth login
idle-agent auth status
idle-agent auth logout
```

Login displays a QR code for approval by an already authenticated Idle app.
After approval, the app shows a 48-bit verification code. Enter that code in
the Agent before it saves credentials. The Agent verifies the approving
account's signature, selected relay origin, and one-time requester key; a
missing or mismatched code fails closed without writing `agent.key`.
`~/.idle/agent.key` contains a sensitive bearer token and client secret; the
agent validates it through a bounded no-follow descriptor read and creates it
with an atomic owner-only `0600` write inside a private directory. Symlinked
credential targets or directories, multiply linked files, malformed values,
and unsafe POSIX ownership or modes are rejected. Do not share, commit, or
include the file in support output. Set `IDLE_HOME_DIR` to isolate another
credential store; that directory itself and its credential subdirectories must
not be symlinks. The versioned record is bound to the account signing identity
and canonical relay origin. Older unversioned Agent credential files are
intentionally rejected; run `idle-agent auth login` once to establish a
verified v3 pairing.

Windows does not expose Unix owner/mode guarantees and may not provide the same
kernel no-follow open flag. The agent still validates file type, link/path
identity, size, and credential values and uses an exclusive temporary file plus
rename, but the profile directory's Windows ACL remains part of the local trust
boundary.

## Commands

```bash
idle-agent machines [--active] [--json]
idle-agent list [--active] [--json]
idle-agent status <session-id> [--json]
idle-agent spawn --machine <machine-id> [--path <path>] [--agent <name>]
idle-agent resume <session-id> [--json]
idle-agent create --tag <tag> [--path <path>] [--json]
idle-agent send <session-id> <message> [--wait] [--json]
idle-agent history <session-id> [--limit <n>] [--json]
idle-agent stop <session-id>
idle-agent wait <session-id> [--timeout <seconds>]
```

Session and machine identifiers accept an unambiguous prefix. `spawn` supports
`claude`, `codex`, `gemini`, and `openclaw`; omit `--agent` to let the machine
choose its default. An omitted `--path`, `~`, or `~/...` is resolved from the
live daemon's current home directory through a fresh authenticated RPC. Relay-
cached machine metadata is not trusted to choose the working directory. Other
`--path` values must be absolute. `--create-dir` explicitly authorizes a missing
working directory to be created. `stop` requires the session's original machine
daemon to be online and reports success only after that daemon confirms
termination.
History reads join current sender-authenticated message identities to the
requested session and outer local ID before display, and deduplicate both
current identities and exact legacy ciphertext within each bounded response.

### Dangerous permission bypass

```bash
idle-agent send <session-id> "Run the task" --yolo
```

`--yolo` asks the remote coding session to use its dangerous approval-bypass
mode. It is never the default. Use it only when you trust the request, repository,
agent, and machine boundary; sandboxing and approval mode are separate controls.

## Encryption boundary

The agent derives client content keys from the approved account credential.
Session messages and session/machine metadata/state are decrypted locally.
Current records use per-record AES-256-GCM keys; legacy records use NaCl
secretbox.

Record identifiers, timestamps, sequence/version counters, activity, usage,
profile, push, voice, and integration metadata remain server-readable. The
relay can decrypt a legacy linked GitHub OAuth token to revoke it during
authenticated disconnect; the current runtime cannot create a new link. See
[Encryption](../../docs/encryption.md) and [Security](../../docs/SECURITY.md).

Machine and session RPC parameters/results are encrypted by the client. Every
current request also authenticates a versioned request ID, issue time, target
scope, method, and params inside the ciphertext; targets reject raw legacy
params, expired requests, and reused identities before dispatch. RPC method
names and target identifiers remain relay-visible. The default spawn directory
comes from the live daemon in a response bound to that request ID, scope, and
method; a captured response from another request is rejected.

## Environment

| Variable | Purpose |
|---|---|
| `IDLE_SERVER_URL` | Override the relay with an exact credential-free HTTP(S) origin |
| `IDLE_HOME_DIR` | Override the credential/data directory with an absolute, non-root path |

Without an override, the package uses the hosted Idle relay. Overrides are
canonicalized and may not include credentials, a path, query, or fragment.
Remote origins require HTTPS; plain HTTP is accepted only for `localhost`,
`.localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1` development endpoints. Agent
HTTP calls disable redirects and enforce finite request, response, and time
limits so a bearer is never forwarded through an HTTP redirect. The credential
home override rejects empty, relative, and filesystem-root paths so an
accidental value cannot place `agent.key` in a working tree or root directory.

## Development

```bash
yarn workspace @northglass/idle-wire build
yarn workspace @northglass/agent build
yarn workspace @northglass/agent test
```

## License

MIT
