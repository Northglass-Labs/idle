import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_SPAWN_DIRECTORY_CHARACTERS = 4_096;
const MAX_SPAWN_IDENTIFIER_CHARACTERS = 512;
const MAX_SPAWN_ENVIRONMENT_ENTRIES = 128;
const MAX_SPAWN_ENVIRONMENT_VALUE_BYTES = 32 * 1024;
const MAX_SPAWN_ENVIRONMENT_TOTAL_BYTES = 256 * 1024;

const SpawnDirectorySchema = z.string()
    .min(1)
    .max(MAX_SPAWN_DIRECTORY_CHARACTERS)
    .refine((value) => !value.includes('\0') && isAbsolute(value));

const SpawnIdentifierSchema = z.string()
    .min(1)
    .max(MAX_SPAWN_IDENTIFIER_CHARACTERS)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const SpawnControlPlaneIdSchema = z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const SpawnBoundedStringSchema = z.string()
    .min(1)
    .max(MAX_SPAWN_IDENTIFIER_CHARACTERS)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const SpawnEnvironmentKeySchema = z.string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value));

const SpawnEnvironmentValueSchema = z.string()
    .refine((value) => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_SPAWN_ENVIRONMENT_VALUE_BYTES);

export const SpawnEnvironmentVariablesSchema = z.record(
    SpawnEnvironmentKeySchema,
    SpawnEnvironmentValueSchema,
).superRefine((value, context) => {
    const entries = Object.entries(value);
    if (entries.length > MAX_SPAWN_ENVIRONMENT_ENTRIES) {
        context.addIssue({
            code: 'custom',
            message: 'Too many environment variables',
        });
        return;
    }

    let aggregateBytes = 0;
    for (const [key, entryValue] of entries) {
        aggregateBytes += Buffer.byteLength(key, 'utf8')
            + 1
            + Buffer.byteLength(entryValue, 'utf8');
        if (aggregateBytes > MAX_SPAWN_ENVIRONMENT_TOTAL_BYTES) {
            context.addIssue({
                code: 'custom',
                message: 'Environment variables exceed the aggregate size limit',
            });
            return;
        }
    }
});

export const SpawnSessionOptionsSchema = z.object({
    directory: SpawnDirectorySchema,
    sessionId: SpawnControlPlaneIdSchema.optional(),
    approvedNewDirectoryCreation: z.boolean().optional(),
    agent: z.enum(['claude', 'codex', 'gemini', 'openclaw']).optional(),
    environmentVariables: SpawnEnvironmentVariablesSchema.optional(),
    commitAttribution: z.boolean().optional(),
    resumeClaudeSessionId: SpawnBoundedStringSchema.optional(),
    resumeCodexThreadId: SpawnIdentifierSchema.optional(),
    parentSessionId: SpawnControlPlaneIdSchema.optional(),
    forkedFromMessageId: SpawnControlPlaneIdSchema.optional(),
    codexProviderNativeSandboxApproved: z.boolean().optional(),
}).strict();

export const RemoteSpawnSessionRequestSchema = SpawnSessionOptionsSchema
    .omit({ sessionId: true })
    .extend({
        type: z.literal('spawn-in-directory').optional(),
        approvedNewDirectoryCreation: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, context) => {
        const hasClaudeResume = value.resumeClaudeSessionId !== undefined;
        const hasCodexResume = value.resumeCodexThreadId !== undefined;
        if (
            (hasClaudeResume && value.agent !== undefined && value.agent !== 'claude')
            || (hasCodexResume && value.agent !== 'codex')
            || (hasClaudeResume && hasCodexResume)
            || (value.forkedFromMessageId !== undefined && value.parentSessionId === undefined)
        ) {
            context.addIssue({
                code: 'custom',
                message: 'Inconsistent spawn session coordinates',
            });
        }
    });

export const LoopbackSpawnSessionRequestSchema = SpawnSessionOptionsSchema
    .pick({
        directory: true,
        sessionId: true,
        agent: true,
        environmentVariables: true,
    })
    .strict();

export type SpawnSessionOptions = z.infer<typeof SpawnSessionOptionsSchema>;

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'requestToApproveCodexNativeSandbox' }
    | { type: 'error'; errorMessage: string };
