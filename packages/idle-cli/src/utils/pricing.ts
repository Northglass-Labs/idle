import type { Usage } from '../api/types';

/** Rates are USD per million tokens. */
export type PricingRates = Readonly<{
    input: number;
    output: number;
    cache_write: number;
    cache_write_1h: number;
    cache_read: number;
}>;

export type CostBreakdown = Readonly<{
    total: number;
    input: number;
    output: number;
}>;

const OPUS_CURRENT: PricingRates = {
    input: 5,
    output: 25,
    cache_write: 6.25,
    cache_write_1h: 10,
    cache_read: 0.5,
};

const OPUS_CLASSIC: PricingRates = {
    input: 15,
    output: 75,
    cache_write: 18.75,
    cache_write_1h: 30,
    cache_read: 1.5,
};

const SONNET_STANDARD: PricingRates = {
    input: 3,
    output: 15,
    cache_write: 3.75,
    cache_write_1h: 6,
    cache_read: 0.3,
};

const SONNET_5_INTRODUCTORY: PricingRates = {
    input: 2,
    output: 10,
    cache_write: 2.5,
    cache_write_1h: 4,
    cache_read: 0.2,
};

const HAIKU_4_5: PricingRates = {
    input: 1,
    output: 5,
    cache_write: 1.25,
    cache_write_1h: 2,
    cache_read: 0.1,
};

const HAIKU_3_5: PricingRates = {
    input: 0.8,
    output: 4,
    cache_write: 1,
    cache_write_1h: 1.6,
    cache_read: 0.08,
};

const HAIKU_3: PricingRates = {
    input: 0.25,
    output: 1.25,
    cache_write: 0.3125,
    cache_write_1h: 0.5,
    cache_read: 0.025,
};

/**
 * Model IDs and rates follow Anthropic's published catalog. The usage payload
 * includes a TTL breakdown when one-hour cache writes are present.
 * https://platform.claude.com/docs/en/about-claude/pricing
 * https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
 * https://platform.claude.com/docs/en/docs/about-claude/models/whats-new-sonnet-5
 */
export const PRICING = {
    'claude-opus-4-8': OPUS_CURRENT,
    'claude-opus-4-7': OPUS_CURRENT,
    'claude-opus-4-6': OPUS_CURRENT,
    'claude-opus-4-5': OPUS_CURRENT,
    'claude-sonnet-5': SONNET_STANDARD,
    'claude-sonnet-4-6': SONNET_STANDARD,
    'claude-sonnet-4-5': SONNET_STANDARD,
    'claude-haiku-4-5': HAIKU_4_5,
    'claude-opus-4-1': OPUS_CLASSIC,
    'claude-opus-4': OPUS_CLASSIC,
    'claude-sonnet-4': SONNET_STANDARD,
    'claude-3-opus': OPUS_CLASSIC,
    'claude-3-sonnet': SONNET_STANDARD,
    'claude-3-5-sonnet': SONNET_STANDARD,
    'claude-3-5-haiku': HAIKU_3_5,
    'claude-3-haiku': HAIKU_3,
} as const satisfies Record<string, PricingRates>;

export type ModelId = keyof typeof PRICING;

const MODEL_PREFIXES_LONGEST_FIRST = (Object.keys(PRICING) as ModelId[])
    .sort((left, right) => right.length - left.length);
const SONNET_5_STANDARD_START_UTC = Date.UTC(2026, 8, 1);
const MAX_MODEL_ID_CHARACTERS = 128;
const CLAUDE_MODEL_ID = /^claude(?:-[a-z0-9]+){2,8}$/;
const DATE_SUFFIX = /^-\d{8}$/;
const MAX_USAGE_TOKEN_COUNT = 1_000_000_000;

export function normalizeClaudeModelId(modelId: unknown): string | null {
    if (typeof modelId !== 'string' || modelId.length > MAX_MODEL_ID_CHARACTERS) {
        return null;
    }
    const normalized = modelId.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > MAX_MODEL_ID_CHARACTERS) {
        return null;
    }
    return CLAUDE_MODEL_ID.test(normalized) ? normalized : null;
}

function matchesCatalogEntry(modelId: string, catalogId: ModelId): boolean {
    if (modelId === catalogId) {
        return true;
    }
    return modelId.startsWith(catalogId)
        && DATE_SUFFIX.test(modelId.slice(catalogId.length));
}

function resolvePricing(modelId: unknown, at: Date): PricingRates | null {
    const normalized = normalizeClaudeModelId(modelId);
    if (!normalized) {
        return null;
    }

    const catalogId = MODEL_PREFIXES_LONGEST_FIRST.find((entry) => (
        matchesCatalogEntry(normalized, entry)
    ));
    if (!catalogId) {
        return null;
    }

    if (catalogId === 'claude-sonnet-5') {
        const timestamp = at instanceof Date ? at.getTime() : Number.NaN;
        if (!Number.isFinite(timestamp)) {
            return null;
        }
        return timestamp < SONNET_5_STANDARD_START_UTC
            ? SONNET_5_INTRODUCTORY
            : SONNET_STANDARD;
    }
    return PRICING[catalogId];
}

function isUsageTokenCount(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) >= 0
        && (value as number) <= MAX_USAGE_TOKEN_COUNT;
}

function isOptionalUsageTokenCount(value: unknown): value is number | null | undefined {
    return value === null || value === undefined || isUsageTokenCount(value);
}

function cacheWriteCost(usage: Usage, pricing: PricingRates): number | null {
    const aggregate = usage.cache_creation_input_tokens;
    if (!isOptionalUsageTokenCount(aggregate)) {
        return null;
    }

    const breakdown = usage.cache_creation;
    if (breakdown === null || breakdown === undefined) {
        return ((aggregate ?? 0) / 1_000_000) * pricing.cache_write;
    }
    if (
        typeof breakdown !== 'object'
        || !isUsageTokenCount(breakdown.ephemeral_1h_input_tokens)
        || !isUsageTokenCount(breakdown.ephemeral_5m_input_tokens)
        || aggregate === null
        || aggregate === undefined
        || aggregate !== breakdown.ephemeral_1h_input_tokens + breakdown.ephemeral_5m_input_tokens
    ) {
        return null;
    }

    return (
        (breakdown.ephemeral_1h_input_tokens / 1_000_000) * pricing.cache_write_1h
        + (breakdown.ephemeral_5m_input_tokens / 1_000_000) * pricing.cache_write
    );
}

/** Return `null` when the model does not have a reviewed catalog rate. */
export function calculateCost(
    usage: Usage,
    modelId?: string,
    at: Date = new Date(),
): CostBreakdown | null {
    const pricing = resolvePricing(modelId, at);
    if (
        !pricing
        || !isUsageTokenCount(usage.input_tokens)
        || !isUsageTokenCount(usage.output_tokens)
        || !isOptionalUsageTokenCount(usage.cache_read_input_tokens)
    ) {
        return null;
    }

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
    const resolvedCacheWriteCost = cacheWriteCost(usage, pricing);
    if (resolvedCacheWriteCost === null) {
        return null;
    }
    const cacheReadCost = (
        (usage.cache_read_input_tokens ?? 0) / 1_000_000
    ) * pricing.cache_read;
    const totalInputCost = inputCost + resolvedCacheWriteCost + cacheReadCost;

    return {
        total: totalInputCost + outputCost,
        input: totalInputCost,
        output: outputCost,
    };
}
