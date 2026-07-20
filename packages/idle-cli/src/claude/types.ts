/**
 * Simplified schema that only validates fields actually used in the codebase
 * while preserving all other fields through passthrough()
 */

import { z } from "zod";

const MAX_USAGE_TOKEN_COUNT = 1_000_000_000;
const UsageTokenCountSchema = z.number()
  .finite()
  .int()
  .nonnegative()
  .max(MAX_USAGE_TOKEN_COUNT);
const CacheCreationSchema = z.object({
  ephemeral_1h_input_tokens: UsageTokenCountSchema,
  ephemeral_5m_input_tokens: UsageTokenCountSchema,
}).strict();

export const UsageSchema = z.object({
  input_tokens: UsageTokenCountSchema,
  cache_creation_input_tokens: UsageTokenCountSchema.nullable().optional(),
  cache_read_input_tokens: UsageTokenCountSchema.nullable().optional(),
  cache_creation: CacheCreationSchema.nullable().optional(),
  output_tokens: UsageTokenCountSchema,
  service_tier: z.string().max(64).nullable().optional(),
}).passthrough().superRefine((usage, context) => {
  if (usage.cache_creation === null || usage.cache_creation === undefined) {
    return;
  }
  const breakdownTotal = usage.cache_creation.ephemeral_1h_input_tokens
    + usage.cache_creation.ephemeral_5m_input_tokens;
  if (
    usage.cache_creation_input_tokens === null
    || usage.cache_creation_input_tokens === undefined
    || usage.cache_creation_input_tokens !== breakdownTotal
  ) {
    context.addIssue({
      code: 'custom',
      message: 'cache creation breakdown must equal its aggregate',
      path: ['cache_creation'],
    });
  }
});

// Main schema with minimal validation for only the fields we use
// NOTE: Schema is intentionally lenient to handle various Claude Code message formats
// including synthetic error messages, API errors, and different SDK versions
export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message - validates uuid and message.content
  z.object({
    type: z.literal("user"),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
    uuid: z.string(), // Used in getMessageKey()
    message: z.object({
      content: z.union([z.string(), z.any()]) // Used in sessionScanner.ts
    }).passthrough()
  }).passthrough(),

  // Assistant message - only validates uuid and type
  // message object is optional to handle synthetic error messages (isApiErrorMessage: true)
  // which may have different structure than normal assistant messages
  z.object({
    uuid: z.string(),
    type: z.literal("assistant"),
    message: z.object({
      usage: UsageSchema.optional(), // Used in apiSession.ts
      model: z.string().optional(), // Used for cost calculation
    }).passthrough().optional()
  }).passthrough(),

  // Summary message - validates summary and leafUuid
  z.object({
    type: z.literal("summary"),
    summary: z.string(), // Used in apiSession.ts
    leafUuid: z.string() // Used in getMessageKey()
  }).passthrough(),

  // System message - validates uuid
  z.object({
    type: z.literal("system"),
    uuid: z.string() // Used in getMessageKey()
  }).passthrough()
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>
