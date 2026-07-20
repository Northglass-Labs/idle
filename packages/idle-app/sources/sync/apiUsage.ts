import type { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getIdleClientId } from './apiSocket';
import { readBoundedJsonResponse } from './boundedJsonResponse';
import { streamingFetch } from './streamingFetch';
import { z } from 'zod';

const MAX_USAGE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_QUERY_TIMESTAMP_SECONDS = 253_402_300_799;
const MAX_AGGREGATED_TOKEN_COUNT = 1_000_000_000_000;
const MAX_AGGREGATED_COST = 1_000_000_000;

const AggregatedTokenCountSchema = z.number()
    .finite()
    .int()
    .nonnegative()
    .max(MAX_AGGREGATED_TOKEN_COUNT);
const AggregatedCostSchema = z.number()
    .finite()
    .nonnegative()
    .max(MAX_AGGREGATED_COST);

const UsageTokensSchema = z.object({
    total: AggregatedTokenCountSchema,
    input: AggregatedTokenCountSchema,
    output: AggregatedTokenCountSchema,
    cache_creation: AggregatedTokenCountSchema,
    cache_read: AggregatedTokenCountSchema,
}).strict().superRefine((tokens, context) => {
    if (tokens.total !== tokens.input + tokens.output + tokens.cache_creation + tokens.cache_read) {
        context.addIssue({
            code: 'custom',
            path: ['total'],
            message: 'Token total must equal the component sum',
        });
    }
});

const UsageCostsSchema = z.object({
    total: AggregatedCostSchema,
    input: AggregatedCostSchema,
    output: AggregatedCostSchema,
}).strict();

const UsageDataPointSchema = z.object({
    timestamp: z.number().finite().int().nonnegative().max(MAX_USAGE_QUERY_TIMESTAMP_SECONDS),
    tokens: UsageTokensSchema,
    cost: UsageCostsSchema,
    reportCount: z.number().int().positive().max(1_000),
}).strict();

export const UsageResponseSchema = z.object({
    usage: z.array(UsageDataPointSchema).max(1_000),
    groupBy: z.enum(['hour', 'day']),
    totalReports: z.number().int().nonnegative().max(1_000),
}).strict();

export const UsageQueryParamsSchema = z.object({
    sessionId: z.string().min(1).max(64).optional(),
    startTime: z.number().finite().int().nonnegative().max(MAX_USAGE_QUERY_TIMESTAMP_SECONDS).optional(),
    endTime: z.number().finite().int().nonnegative().max(MAX_USAGE_QUERY_TIMESTAMP_SECONDS).optional(),
    groupBy: z.enum(['hour', 'day']).optional(),
}).strict().superRefine((params, context) => {
    if (params.startTime !== undefined
        && params.endTime !== undefined
        && params.startTime > params.endTime) {
        context.addIssue({
            code: 'custom',
            path: ['startTime'],
            message: 'Start time must not be after end time',
        });
    }
});

export type UsageDataPoint = z.infer<typeof UsageDataPointSchema>;
export type UsageQueryParams = z.infer<typeof UsageQueryParamsSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

/**
 * Query usage data from the server
 */
export async function queryUsage(
    credentials: AuthCredentials,
    params: UsageQueryParams = {}
): Promise<UsageResponse> {
    const API_ENDPOINT = getServerUrl();
    const validatedParams = UsageQueryParamsSchema.parse(params);

    return await backoff(async () => {
        const response = await streamingFetch(`${API_ENDPOINT}/v1/usage/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getIdleClientId(),
            },
            body: JSON.stringify(validatedParams)
        });

        if (!response.ok) {
            if (response.status === 404 && validatedParams.sessionId) {
                throw new Error('Session not found');
            }
            throw new Error(`Failed to query usage: ${response.status}`);
        }

        const data = UsageResponseSchema.parse(await readBoundedJsonResponse(
            response,
            MAX_USAGE_RESPONSE_BYTES,
        ));
        return data;
    });
}

/**
 * Helper function to get usage for a specific time period
 */
export async function getUsageForPeriod(
    credentials: AuthCredentials,
    period: 'today' | '7days' | '30days',
    sessionId?: string
): Promise<UsageResponse> {
    const now = Math.floor(Date.now() / 1000);
    const oneDaySeconds = 24 * 60 * 60;

    let startTime: number;
    let groupBy: 'hour' | 'day';

    switch (period) {
        case 'today':
            // Start of today (local timezone)
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            startTime = Math.floor(today.getTime() / 1000);
            groupBy = 'hour';
            break;
        case '7days':
            startTime = now - (7 * oneDaySeconds);
            groupBy = 'day';
            break;
        case '30days':
            startTime = now - (30 * oneDaySeconds);
            groupBy = 'day';
            break;
    }

    return queryUsage(credentials, {
        sessionId,
        startTime,
        endTime: now,
        groupBy
    });
}

/**
 * Calculate total tokens and cost from usage data
 */
export function calculateTotals(usage: UsageDataPoint[]): {
    totalTokens: number;
    totalCost: number;
    tokensByType: Record<string, number>;
    costByType: Record<string, number>;
} {
    const result = {
        totalTokens: 0,
        totalCost: 0,
        tokensByType: {
            input: 0,
            output: 0,
            cache_creation: 0,
            cache_read: 0,
        } as Record<string, number>,
        costByType: { input: 0, output: 0 } as Record<string, number>,
    };

    for (const dataPoint of usage) {
        result.totalTokens += dataPoint.tokens.total;
        result.totalCost += dataPoint.cost.total;

        for (const key of ['input', 'output', 'cache_creation', 'cache_read'] as const) {
            result.tokensByType[key] += dataPoint.tokens[key];
        }
        for (const key of ['input', 'output'] as const) {
            result.costByType[key] += dataPoint.cost[key];
        }
    }

    return result;
}

export function getUsageMetricValue(
    point: UsageDataPoint,
    metric: 'tokens' | 'cost',
): number {
    return metric === 'tokens' ? point.tokens.total : point.cost.total;
}
