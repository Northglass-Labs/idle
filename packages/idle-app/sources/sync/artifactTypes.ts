import { z } from 'zod';

const SafeNonnegativeIntegerSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = SafeNonnegativeIntegerSchema.max(253_402_300_799_000);
const EncryptedHeaderSchema = z.string().max(16_384);
const EncryptedBodySchema = z.string().min(1).max(65_536);
const EncryptedKeySchema = z.string().min(1).max(1_024);

export const ArtifactIdSchema = z.string().uuid().max(64);

export const ArtifactListItemSchema = z.object({
    id: ArtifactIdSchema,
    header: EncryptedHeaderSchema,
    headerVersion: SafeNonnegativeIntegerSchema,
    dataEncryptionKey: EncryptedKeySchema,
    seq: SafeNonnegativeIntegerSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
}).strict();

export const ArtifactListResponseSchema = z.array(ArtifactListItemSchema)
    .max(200)
    .superRefine((artifacts, context) => {
        const seen = new Set<string>();
        artifacts.forEach((artifact, index) => {
            if (seen.has(artifact.id)) {
                context.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: 'Duplicate artifact ID',
                });
            }
            seen.add(artifact.id);
        });
    });

export const ArtifactFullResponseSchema = ArtifactListItemSchema.extend({
    body: EncryptedBodySchema,
    bodyVersion: SafeNonnegativeIntegerSchema,
}).strict();

export const ArtifactCreateRequestSchema = z.object({
    id: ArtifactIdSchema,
    header: EncryptedHeaderSchema,
    body: EncryptedBodySchema,
    dataEncryptionKey: EncryptedKeySchema,
}).strict();

export const ArtifactUpdateRequestSchema = z.object({
    header: EncryptedHeaderSchema.optional(),
    expectedHeaderVersion: SafeNonnegativeIntegerSchema.optional(),
    body: EncryptedBodySchema.optional(),
    expectedBodyVersion: SafeNonnegativeIntegerSchema.optional(),
}).strict().superRefine((request, context) => {
    const hasHeader = request.header !== undefined;
    const hasHeaderVersion = request.expectedHeaderVersion !== undefined;
    const hasBody = request.body !== undefined;
    const hasBodyVersion = request.expectedBodyVersion !== undefined;

    if (hasHeader !== hasHeaderVersion) {
        context.addIssue({
            code: 'custom',
            path: ['expectedHeaderVersion'],
            message: 'Header and expected version must be provided together',
        });
    }
    if (hasBody !== hasBodyVersion) {
        context.addIssue({
            code: 'custom',
            path: ['expectedBodyVersion'],
            message: 'Body and expected version must be provided together',
        });
    }
    if (!hasHeader && !hasBody) {
        context.addIssue({
            code: 'custom',
            message: 'Artifact update must include a header or body',
        });
    }
});

export const ArtifactUpdateResponseSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        headerVersion: SafeNonnegativeIntegerSchema.optional(),
        bodyVersion: SafeNonnegativeIntegerSchema.optional(),
    }).strict(),
    z.object({
        success: z.literal(false),
        error: z.literal('version-mismatch'),
        currentHeaderVersion: SafeNonnegativeIntegerSchema.optional(),
        currentBodyVersion: SafeNonnegativeIntegerSchema.optional(),
        currentHeader: EncryptedHeaderSchema.optional(),
        currentBody: EncryptedBodySchema.optional(),
    }).strict(),
]);

/**
 * Encrypted artifact from API
 */
export interface Artifact {
    id: string;
    header: string;  // Base64 encoded encrypted JSON { "title": string | null }
    headerVersion: number;
    body?: string;  // Base64 encoded encrypted JSON { "body": string | null } - only in full fetch
    bodyVersion?: number;  // Only in full fetch
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
    seq: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Decrypted artifact header
 */
export interface ArtifactHeader {
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
}

/**
 * Decrypted artifact body
 */
export interface ArtifactBody {
    body: string | null;
}

/**
 * Decrypted artifact for UI
 */
export interface DecryptedArtifact {
    id: string;
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
    body?: string | null;  // Only loaded when viewing full artifact
    headerVersion: number;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    isDecrypted: boolean;  // Whether decryption was successful
}

/**
 * Request to create a new artifact
 */
export interface ArtifactCreateRequest {
    id: string;  // UUID generated client-side
    header: string;  // Base64 encoded encrypted header
    body: string;  // Base64 encoded encrypted body
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
}

/**
 * Request to update an existing artifact
 */
export interface ArtifactUpdateRequest {
    header?: string;  // Base64 encoded encrypted header
    expectedHeaderVersion?: number;
    body?: string;  // Base64 encoded encrypted body
    expectedBodyVersion?: number;
}

/**
 * Response from update operation
 */
export type ArtifactUpdateResponse =
    | {
        success: true;
        headerVersion?: number;
        bodyVersion?: number;
    }
    | {
        success: false;
        error: 'version-mismatch';
        currentHeaderVersion?: number;
        currentBodyVersion?: number;
        currentHeader?: string;
        currentBody?: string;
    };
