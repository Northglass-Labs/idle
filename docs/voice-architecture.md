# Voice Architecture

How the ElevenLabs voice assistant integrates with the Idle app, routes messages to sessions, and manages context delivery.

## Components

```text
SessionView.tsx            UI — mic button, triggers voice start/stop
RealtimeSession.ts         Lifecycle — start/stop, token fetch, session routing state
RealtimeVoiceSession.tsx   Native ElevenLabs bridge (useConversation hook)
RealtimeVoiceSession.web.tsx  Web ElevenLabs bridge (same interface)
voiceHooks.ts              Context delivery — formats and routes app events to voice agent
contextFormatters.ts       Text formatters for session context, messages, permissions
realtimeClientTools.ts     Tool implementations the voice agent can invoke
voiceConfig.ts             Feature flags and constants
storage.ts                 Global state (realtimeStatus, realtimeMode)
types.ts                   Shared type definitions
```

## Session Routing

A module-level `currentSessionId` in `RealtimeSession.ts` tracks the session the
user most recently focused while voice is active. It is used for focus dedup and
current-session context; it is not an authorization decision.

- **Message routing**: `sendMessageToSession` receives an opaque session ID,
  validates an authenticated local target, requires local confirmation, and
  rechecks that target after confirmation before sending.
- **Permission routing**: `processPermissionRequest` receives an exact opaque
  session/request pair and resolves only that pair against authenticated
  pending state. An allow shows the target and complete local request before
  confirmation; denial remains the fail-safe path.
- **Focus dedup**: `voiceHooks.onSessionFocus()` compares against the current ID
  to avoid re-injecting context for the already-focused session.

When the user navigates to a different session while voice is active, `onSessionFocus` updates `currentSessionId` so subsequent voice commands route to the newly viewed session.

```text
User taps mic on Session A
  │
  v
startRealtimeSession("A")
  └──> currentSessionId = "A"

User navigates to Session B
  │
  v
sync.onSessionVisible("B")
  └──> voiceHooks.onSessionFocus("B")
         └──> setCurrentRealtimeSessionId("B")

Voice agent calls sendMessageToSession({ sessionId: "B", message: ... })
  └──> validate target → local confirmation → revalidate → send
```

## Voice Start

When the voice session starts, `onVoiceStarted(sessionId)` builds an initial prompt containing:

1. **Session directory** — a bounded list of active-session opaque IDs plus
   bounded titles or summaries. The current session is prioritized.
2. **Current session context** — a bounded recent transcript window via
   `injectSessionContext(sessionId)`. Recent messages are selected first and
   presented chronologically. Local project, home, and host paths are omitted.

```text
onVoiceStarted("A")
  │
  ├──> formatSessionDirectory()
  │      → "Available sessions:\n- abc: "Refactor auth"\n- def: "Fix dark mode""
  │
  └──> injectSessionContext("A")
         → "# Current coding-session context\nOpaque session ID: ...\n## Recent transcript updates\n..."
```

## Context Delivery

App events are delivered to the voice agent through two channels with different semantics:

### sendContext() — silent background injection

Calls `voice.sendContextualUpdate()`. The agent receives the information but does **not** respond. Always sent immediately, never queued.

Used for: new messages, session focus changes, session online/offline, and
bounded recent-session context.

### sendPrompt() — triggers agent response

Calls `voice.sendTextMessage()`. Acts as a user turn — the agent will respond. **Queued while anyone is speaking**, flushed as a single batch when mode transitions to `idle`.

Used for: permission requests, ready events (agent finished working).

### Batching

When the user or agent is speaking, prompts enter a count- and byte-bounded
queue. A zustand subscription on `realtimeMode` triggers a bounded flush when
mode returns to `idle`.

```text
realtimeMode = 'agent-speaking'
  │
  ├── onReady("abc")        → sendPrompt() → queued
  ├── onPermission("abc")   → sendPrompt() → queued
  ├── onMessages("abc")     → sendContext() → sent immediately
  │
  v
realtimeMode → 'idle'
  │
  v
flushPendingPrompts()
  └──> voice.sendTextMessage(joined prompts)
```

### Session Context Injection

`injectSessionContext(sessionId)` is the shared code path for injecting bounded
session context. It is used by both `onVoiceStarted` and `onSessionFocus`, and
tracks which sessions have already been shown to avoid redundant transcript
updates. Titles, summaries, transcripts, and tool names are untrusted data, not
authority for a client-tool call.

## Realtime Mode

`realtimeMode` in storage tracks who is currently speaking:

| Mode | Meaning | Source |
|------|---------|--------|
| `idle` | Nobody is talking | Default / after speech ends |
| `agent-speaking` | ElevenLabs agent is producing audio | `onModeChange({ mode: 'speaking' })` |
| `user-speaking` | User mic VAD is above threshold | `onVadScore({ vadScore })` |

Priority: `agent-speaking` > `user-speaking` > `idle`. If both fire simultaneously, agent wins (user speech during agent output is likely crosstalk).

### VAD Detection

ElevenLabs provides `onVadScore({ vadScore: number })` — a continuous 0-1 signal for user microphone activity. We derive a binary state with debounce:

- `vadScore > VAD_THRESHOLD` (0.5) → `user-speaking`, reset silence timer
- `vadScore <= VAD_THRESHOLD` → start silence timer (`VAD_SILENCE_MS` = 300ms), transition to `idle` on timeout

Agent mode changes (`onModeChange`) take priority over VAD. When `onModeChange` reports `'speaking'`, we set `agent-speaking` regardless of VAD. When it reports `'listening'`, we defer to VAD state.

```text
ElevenLabs SDK
  │
  ├── onModeChange({ mode: 'speaking' })
  │     └──> realtimeMode = 'agent-speaking'
  │
  ├── onModeChange({ mode: 'listening' })
  │     └──> realtimeMode = (VAD active ? 'user-speaking' : 'idle')
  │
  └── onVadScore({ vadScore })
        └──> if agent not speaking:
               vadScore > 0.5 → 'user-speaking'
               vadScore ≤ 0.5 → debounce → 'idle'
```

## Voice Agent Tools

The voice agent can invoke these client tools (defined in `realtimeClientTools.ts`):

- **sendMessageToSession** — parameters `sessionId` and `message`; both are
  bounded. Messages larger than 1 KiB are rejected instead of truncated. The
  app shows the exact complete message in a scrollable local confirmation and
  re-authenticates the exact session immediately afterward before calling
  `sync.sendMessage`.
- **processPermissionRequest** — parameters `sessionId`, `requestId`, and
  `decision`; the identifiers are bounded and the object is strict. An allow
  shows the exact local target, request ID, tool, and complete authenticated
  request in a non-truncating review capped at 16 KiB. Display-affecting control
  characters are escaped, unreviewable requests fail closed, and the complete
  request snapshot is rechecked before approval. A denial may proceed without
  confirmation as the fail-safe action, but still requires the exact pair.

Idle does not separately add stored project paths or permission arguments to
provider payloads. Transcript text can itself contain sensitive data.

## Lifecycle

```text
App mounts RealtimeVoiceSession component
  └──> useConversation() hook initializes
  └──> registerVoiceSession(impl) — makes the instance available globally

User taps mic
  └──> voiceHooks.onVoiceStarted(sessionId) — builds initial prompt
  └──> startRealtimeSession(sessionId, prompt)
         ├──> fetchVoiceToken() — server-side gating
         ├──> currentSessionId = sessionId
         └──> voiceSession.startSession({ token, initialContext, ... })

User taps mic again (or navigates away)
  └──> stopRealtimeSession()
         ├──> voiceSession.endSession()
         ├──> currentSessionId = null
         └──> voiceHooks.onVoiceStopped() — clears state
```
