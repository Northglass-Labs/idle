export const CLAUDE_3_ERA_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_CONTEXT_WINDOW = CLAUDE_3_ERA_CONTEXT_WINDOW;

/**
 * Values follow Anthropic's published model context-window table.
 * https://platform.claude.com/docs/en/build-with-claude/context-windows
 */
const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
    'claude-opus-4-8': EXTENDED_CONTEXT_WINDOW,
    'claude-opus-4-7': EXTENDED_CONTEXT_WINDOW,
    'claude-opus-4-6': EXTENDED_CONTEXT_WINDOW,
    'claude-sonnet-5': EXTENDED_CONTEXT_WINDOW,
    'claude-sonnet-4-6': EXTENDED_CONTEXT_WINDOW,
    'claude-opus-4-5': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-sonnet-4-5': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-haiku-4-5': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-opus-4-1': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-opus-4': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-sonnet-4': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-3-5-sonnet': CLAUDE_3_ERA_CONTEXT_WINDOW,
    'claude-3-haiku': CLAUDE_3_ERA_CONTEXT_WINDOW,
};

const MODEL_PREFIXES_LONGEST_FIRST = Object.keys(CONTEXT_WINDOW_BY_MODEL)
    .sort((left, right) => right.length - left.length);
const DATE_SUFFIX = /^-\d{8}$/;

function matchesModel(modelCode: string, catalogId: string): boolean {
    return modelCode === catalogId || (
        modelCode.startsWith(catalogId)
        && DATE_SUFFIX.test(modelCode.slice(catalogId.length))
    );
}

export function getMaxContextSize(modelCode: string | null | undefined): number {
    if (typeof modelCode !== 'string' || modelCode.length > 128) {
        return DEFAULT_CONTEXT_WINDOW;
    }
    const normalized = modelCode.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 128) {
        return DEFAULT_CONTEXT_WINDOW;
    }
    const catalogId = MODEL_PREFIXES_LONGEST_FIRST.find((entry) => (
        matchesModel(normalized, entry)
    ));
    return catalogId ? CONTEXT_WINDOW_BY_MODEL[catalogId] : DEFAULT_CONTEXT_WINDOW;
}

export function getEnsoContextSize(
    metadata: { currentModelCode?: string | null; flavor?: string | null } | null | undefined,
): number {
    return getMaxContextSize(metadata?.currentModelCode);
}
