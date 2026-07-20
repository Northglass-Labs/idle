import { z } from 'zod';

const MAX_RPC_OUTPUT_CHARACTERS = 8 * 1024 * 1024;
const MAX_FILE_RESPONSE_BASE64_CHARACTERS = Math.ceil((8 * 1024 * 1024) / 3) * 4;
const MAX_REWIND_POINTS = 500;
const MAX_REWIND_TEXT_CHARACTERS = 65_536;
const MAX_TIMESTAMP_MS = 253_402_300_799_000;

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.number().int().nonnegative().max(MAX_TIMESTAMP_MS);
const IdentifierSchema = z.string().min(1).max(256).refine(
    (value) => !/[\u0000-\u001F\u007F]/.test(value),
    'Invalid identifier',
);
const DirectorySchema = z.string().min(1).max(16_384).refine(
    (value) => !value.includes('\0'),
    'Invalid directory',
);
const ErrorTextSchema = z.string().min(1).max(16_384);
const OutputTextSchema = z.string().max(MAX_RPC_OUTPUT_CHARACTERS);
const ExitCodeSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

function isCanonicalBase64Shape(value: string): boolean {
    if (value.length === 0) return true;
    if (value.length % 4 !== 0) return false;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const contentLength = value.length - padding;
    for (let index = 0; index < contentLength; index += 1) {
        const code = value.charCodeAt(index);
        const isBase64Character = (
            (code >= 48 && code <= 57)
            || (code >= 65 && code <= 90)
            || (code >= 97 && code <= 122)
            || code === 43
            || code === 47
        );
        if (!isBase64Character) return false;
    }
    for (let index = contentLength; index < value.length; index += 1) {
        if (value.charCodeAt(index) !== 61) return false;
    }
    if (padding === 0) return true;
    if (padding === 1 && contentLength % 4 !== 3) return false;
    if (padding === 2 && contentLength % 4 !== 2) return false;

    const finalCode = value.charCodeAt(contentLength - 1);
    const finalValue = finalCode >= 65 && finalCode <= 90
        ? finalCode - 65
        : finalCode >= 97 && finalCode <= 122
            ? finalCode - 71
            : finalCode >= 48 && finalCode <= 57
                ? finalCode + 4
                : finalCode === 43 ? 62 : 63;
    return padding === 1
        ? (finalValue & 0b11) === 0
        : (finalValue & 0b1111) === 0;
}

const Base64FileContentSchema = z.string()
    .max(MAX_FILE_RESPONSE_BASE64_CHARACTERS)
    .refine(isCanonicalBase64Shape, 'Invalid base64 file content');

export const SpawnSessionResultSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), sessionId: IdentifierSchema }).strict(),
    z.object({
        type: z.literal('requestToApproveDirectoryCreation'),
        directory: DirectorySchema,
    }).strict(),
    z.object({ type: z.literal('requestToApproveCodexNativeSandbox') }).strict(),
    z.object({ type: z.literal('error'), errorMessage: ErrorTextSchema }).strict(),
]);

export const ClaudeForkSessionResultSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), newClaudeSessionId: IdentifierSchema }).strict(),
    z.object({ type: z.literal('error'), errorMessage: ErrorTextSchema }).strict(),
]);

export const CodexForkThreadResultSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), newCodexThreadId: IdentifierSchema }).strict(),
    z.object({ type: z.literal('error'), errorMessage: ErrorTextSchema }).strict(),
]);

const RewindTextSchema = z.string().min(1).max(MAX_REWIND_TEXT_CHARACTERS);
const ClaudeRewindPointsSchema = z.array(z.object({
    uuid: IdentifierSchema,
    text: RewindTextSchema,
    timestamp: TimestampSchema,
}).strict()).max(MAX_REWIND_POINTS).superRefine((points, context) => {
    const seen = new Set<string>();
    points.forEach((point, index) => {
        if (seen.has(point.uuid)) {
            context.addIssue({
                code: 'custom',
                path: [index, 'uuid'],
                message: 'Duplicate rewind identity',
            });
        }
        seen.add(point.uuid);
    });
});
const CodexRewindPointsSchema = z.array(z.object({
    itemId: IdentifierSchema,
    text: RewindTextSchema,
    timestamp: TimestampSchema,
}).strict()).max(MAX_REWIND_POINTS).superRefine((points, context) => {
    const seen = new Set<string>();
    points.forEach((point, index) => {
        if (seen.has(point.itemId)) {
            context.addIssue({
                code: 'custom',
                path: [index, 'itemId'],
                message: 'Duplicate rewind identity',
            });
        }
        seen.add(point.itemId);
    });
});

export const ClaudeListRewindPointsResultSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), points: ClaudeRewindPointsSchema }).strict(),
    z.object({ type: z.literal('error'), errorMessage: ErrorTextSchema }).strict(),
]);

export const CodexListRewindPointsResultSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('success'), points: CodexRewindPointsSchema }).strict(),
    z.object({ type: z.literal('error'), errorMessage: ErrorTextSchema }).strict(),
]);

export const CommandResponseSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        stdout: OutputTextSchema,
        stderr: OutputTextSchema,
        exitCode: ExitCodeSchema,
    }).strict(),
    z.object({
        success: z.literal(false),
        stdout: OutputTextSchema.default(''),
        stderr: OutputTextSchema.default(''),
        exitCode: ExitCodeSchema.default(-1),
        error: ErrorTextSchema.default('Remote command failed'),
    }).strict(),
]);

export const ReadFileResponseSchema = z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), content: Base64FileContentSchema }).strict(),
    z.object({ success: z.literal(false), error: ErrorTextSchema }).strict(),
]);

export const WriteFileResponseSchema = z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ success: z.literal(false), error: ErrorTextSchema }).strict(),
]);

export const KillSessionResponseSchema = z.object({
    success: z.literal(true),
    message: z.string().min(1).max(1_024),
}).strict();

export const StopDaemonResponseSchema = z.object({
    message: z.string().min(1).max(1_024),
}).strict();

export const SwitchResponseSchema = z.boolean();

export const MachineMetadataUpdateResponseSchema = z.discriminatedUnion('result', [
    z.object({
        result: z.literal('success'),
        version: SafeNonnegativeIntegerSchema,
        metadata: z.string().min(1).max(16_384),
    }).strict(),
    z.object({
        result: z.literal('version-mismatch'),
        version: SafeNonnegativeIntegerSchema,
        metadata: z.string().min(1).max(16_384),
    }).strict(),
    z.object({
        result: z.literal('error'),
        message: z.string().min(1).max(1_024),
    }).strict(),
]);

export function parseRpcResult<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        throw new Error('Invalid remote control response');
    }
    return parsed.data;
}
