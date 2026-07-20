import * as z from 'zod';

// Known permission modes at the time of writing. Kept as a const so app/CLI can
// reference it for autocomplete + UI, but the wire schema accepts any string —
// new Claude / Codex SDKs may add modes, and a closed enum here would reject
// the entire message envelope from a newer CLI. The app is responsible for
// clamping unknown values to a sensible default at read time.
export const KNOWN_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'read-only',
  'safe-yolo',
  'yolo',
] as const;
export type KnownPermissionMode = (typeof KNOWN_PERMISSION_MODES)[number];

export const MessageMetaSchema = z.object({
  sentFrom: z.string().optional(),
  permissionMode: z.string().optional(),
  model: z.string().nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  // effortLevel maps to Claude's output_config.effort (low|medium|high) and Codex's
  // model_reasoning_effort (low|medium|high). Stored as a free-form string so the
  // wire format does not break when Anthropic or OpenAI add new tiers. The CLI is
  // responsible for clamping unknown values to a sensible default.
  effortLevel: z.string().nullable().optional(),
  customSystemPrompt: z.string().nullable().optional(),
  appendSystemPrompt: z.string().nullable().optional(),
  allowedTools: z.array(z.string()).nullable().optional(),
  disallowedTools: z.array(z.string()).nullable().optional(),
  displayText: z.string().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;
