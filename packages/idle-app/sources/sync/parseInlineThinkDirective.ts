/**
 * Parse a leading `/think <tier>` or `/ultrathink` directive from a message body.
 *
 * Matches the cogwheel's effort tiers exactly so the slash command and the
 * cogwheel use the same vocabulary. When the message starts with one of
 * the recognised forms, return the tier + the remaining text with the
 * directive stripped. Otherwise return null and the caller passes the
 * original text through unchanged.
 *
 * Accepted forms (case-sensitive, single-space separator):
 *   /think low <text>     → { tier: 'low',    remainingText: '<text>' }
 *   /think medium <text>  → { tier: 'medium', remainingText: '<text>' }
 *   /think high <text>    → { tier: 'high',   remainingText: '<text>' }
 *   /think xhigh <text>   → { tier: 'xhigh',  remainingText: '<text>' }
 *   /think max <text>     → { tier: 'max',    remainingText: '<text>' }
 *   /think low            → { tier: 'low',    remainingText: '' }      ← empty body OK; CLI/Claude can still reason
 *   /ultrathink <text>    → { tier: 'max',    remainingText: '<text>' } ← syntactic sugar for /think max
 *   /ultrathink           → { tier: 'max',    remainingText: '' }
 *
 * /ultrathink is Claude Code's first-class shortcut for maximum-effort
 * reasoning; we accept it as an alias for /think max so users coming from
 * Claude Code don't have to relearn the slash vocabulary.
 *
 * Bare `/think` (no tier) and `/think bogus` (unknown tier) return null —
 * left in the message text to fall through to Claude's natural-language
 * interpretation. This preserves the historic behaviour for things like
 * `/think about this code` where "think" is part of the prompt.
 */

export type EffortTier = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const VALID_TIERS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

export interface InlineThinkDirective {
    tier: EffortTier;
    remainingText: string;
}

export function parseInlineThinkDirective(text: string): InlineThinkDirective | null {
    // /ultrathink — first-class Claude Code alias for /think max.
    // Match either bare `/ultrathink` (whole string) or `/ultrathink <body>`.
    if (text === '/ultrathink') {
        return { tier: 'max', remainingText: '' };
    }
    if (text.startsWith('/ultrathink ')) {
        return { tier: 'max', remainingText: text.slice('/ultrathink '.length) };
    }

    if (!text.startsWith('/think ')) return null;
    const afterPrefix = text.slice('/think '.length);
    // Split on first whitespace: token = tier, rest = body
    const firstSpace = afterPrefix.search(/\s/);
    const tier = firstSpace < 0 ? afterPrefix : afterPrefix.slice(0, firstSpace);
    if (!VALID_TIERS.has(tier)) return null;
    const remaining = firstSpace < 0 ? '' : afterPrefix.slice(firstSpace + 1);
    return { tier: tier as EffortTier, remainingText: remaining };
}
