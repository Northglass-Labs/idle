import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Base system prompt shared across all configurations.
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__idle__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();

/**
 * Co-author credits, appended when the user has explicitly opted in.
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, instead of just giving co-credit to Claude, also give credit to Idle like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)
    via [Idle](https://northglass.io)

    Co-Authored-By: Claude <noreply@anthropic.com>
    Co-Authored-By: Idle <hello@northglass.io>
`))();

/**
 * Attribution opt-out instruction, appended when the user has not opted in.
 *
 * Claude Code's own default is to add `Co-Authored-By: Claude` plus a
 * "Generated with Claude Code" line to commits. Simply omitting the
 * CO_AUTHORED_CREDITS block is not enough — an opted-out Idle user would still
 * get Claude's attribution in their git history. So the opt-out state has to
 * instruct Claude explicitly to attribute nothing. See
 * packages/idle-cli/README.md#commit-attribution.
 */
const NO_ATTRIBUTION_INSTRUCTION = (() => trimIdent(`
    When you create git commits, do not append any attribution trailer to the commit message - no "Co-Authored-By:" lines, and no "Generated with Claude Code" line. Leave the commit message exactly as written.
`))();

/**
 * Build the system prompt. When the user has opted in to co-author credit,
 * append the co-author credits; otherwise append the explicit opt-out
 * instruction so no attribution leaks into their git history.
 *
 * Exported for testing — the `systemPrompt` value below is what callers use.
 */
export function buildSystemPrompt(includeCoAuthored: boolean): string {
  return includeCoAuthored
    ? BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS
    : BASE_SYSTEM_PROMPT + '\n\n' + NO_ATTRIBUTION_INSTRUCTION;
}

/**
 * System prompt with attribution behavior resolved from Claude's settings.
 * Resolved once on startup for performance.
 */
export const systemPrompt = buildSystemPrompt(shouldIncludeCoAuthoredBy());
