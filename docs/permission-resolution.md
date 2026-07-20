# Permission and Sandbox Resolution

Idle's safe default is to keep the coding agent's normal approval behavior. A
sandbox setting and a permission mode are separate controls: configuring a
sandbox does not enable, select, or force `bypassPermissions` or `yolo`.

## Permission Modes

Idle carries a shared set of modes because the supported agents expose
different approval systems:

| Mode | Intended behavior |
|---|---|
| `default` | Use the agent's normal approval policy. This is the default. |
| `acceptEdits` | Claude-compatible edit approval mode. |
| `plan` | Claude-compatible planning mode. |
| `read-only` | Deny writes through the agent's enforced read-only policy. |
| `safe-yolo` | Reduce interruptions while keeping workspace or read-only boundaries. |
| `bypassPermissions` | Explicit Claude-compatible approval bypass. |
| `yolo` | Explicit unrestricted mode where the selected agent supports it. |

Not every mode has a native equivalent in every agent. Conversion happens at
the provider boundary, not in the mobile app.

## Resolution Order

For a new session, the app starts in `default`. For an existing session, an
explicit per-session selection wins over an agent-specific default in Settings.
When neither exists, the app omits a permission override and lets the CLI use
the provider's default.

An outbound message includes a permission mode only when the user or an
agent-specific setting selected one. The CLI accepts later explicit updates so
the user can change modes during a session. A CLI process started with an
explicit dangerous-bypass argument preserves that operator choice against the
legacy clients that used to send `default` on every message.

For Claude, CLI arguments resolve in this order:

1. `--dangerously-skip-permissions`
2. `--permission-mode VALUE` or `--permission-mode=VALUE`
3. the requested session mode
4. `default`

`yolo` maps to Claude's `bypassPermissions`; `safe-yolo` and `read-only` map to
Claude's `default` because the Claude SDK does not provide native equivalents.
The dangerous modes remain supported, but they require an explicit selection.

Codex resolves the shared mode into both an approval policy and a Codex sandbox
policy. `default` uses guarded approvals with workspace-write isolation;
`read-only` enforces a read-only sandbox; and only `yolo` or the compatibility
alias `bypassPermissions` selects `danger-full-access` with no approvals.

Gemini's default requests approval for actionable tools. Its `safe-yolo` and
`read-only` handling use an exact read-only tool allowlist, while `yolo`
explicitly auto-approves tools.

## Sandbox Boundary

Idle never treats a configured sandbox as proof that containment is active.

- Local and remote Claude SDK modes report a sandbox only after their provider
  process wrapper initializes. If required containment cannot initialize,
  startup fails closed. Claude's approval system remains active independently.
- Codex reports the managed sandbox only after its wrapper initializes, and
  still derives its execution policy from the selected permission mode. It runs
  with an empty disposable `CODEX_HOME`; the trusted Idle parent bootstraps only
  an explicit access token or API key through supported Codex interfaces,
  denies the user's normal Codex home to the child, and removes bootstrap
  credential files before any turn starts. Configuration, history, hooks,
  skills, and transcripts are not copied into the sandbox.
- Gemini and generic ACP providers use the same fail-closed process boundary and
  report containment only after it is active. Sandboxed Gemini sessions use a
  private disposable runtime home so the provider can refresh its own state
  without gaining write access to the user's trusted Gemini configuration.

In sandboxed modes, Idle passes only process-operational variables, the selected
provider's credential namespace, and explicit per-session overrides. It does
not copy the daemon's entire environment into the agent. `--no-sandbox` is the
explicit per-session compatibility escape hatch for Claude, Codex, Gemini, and
ACP. For Claude, Gemini, and generic ACP it also restores the provider's normal
full host environment; Codex retains its provider-scoped child environment but
uses the user's normal Codex state instead of the disposable runtime home. This
is the supported compatibility path for consumer ChatGPT login stored by the
official Codex CLI because that login cannot be delegated into Idle's isolated
runtime through a supported public interface.

The session metadata's sandbox field is therefore an observed runtime claim,
not a reason to weaken approvals. See [SECURITY.md](SECURITY.md) for the public
security boundary.
