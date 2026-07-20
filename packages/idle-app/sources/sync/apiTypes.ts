import { z } from 'zod';
import {
    ApiMessageSchema,
    ApiUpdateMachineStateSchema,
    ApiUpdateNewMessageSchema,
    ApiUpdateSessionStateSchema,
    MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS,
    MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS,
    type ApiMessage,
} from '@northglass/idle-wire';
import { GitHubProfileSchema, ImageRefSchema } from './profile';

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const MAX_API_TIMESTAMP_MS = 253_402_300_799_000;
const TimestampSchema = z.number().int().nonnegative().max(MAX_API_TIMESTAMP_MS);
const PersistentUpdateIdSchema = z.string().min(1).max(128);
const IdSchema = z.string().min(1).max(64);
const TagSchema = z.string().min(1).max(128);
const NameSchema = z.string().max(256);
const TokenSchema = z.string().min(1).max(1_024);
const EncryptedMetadataSchema = z.string().max(16_384);
const EncryptedBlobSchema = z.string().min(1).max(65_536);
const UsageTokenCountSchema = z.number().finite().int().nonnegative().max(1_000_000_000);
const UsageCostSchema = z.number().finite().nonnegative().max(1_000_000);

export const ApiMachineSnapshotSchema = z.object({
    id: IdSchema,
    metadata: z.string().max(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS),
    metadataVersion: SafeNonnegativeIntegerSchema,
    daemonState: z.string().min(1).max(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS).nullable(),
    daemonStateVersion: SafeNonnegativeIntegerSchema,
    dataEncryptionKey: TokenSchema.nullable(),
    seq: SafeNonnegativeIntegerSchema,
    active: z.boolean(),
    activeAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
}).strict();

export const ApiMachinesResponseSchema = z.array(ApiMachineSnapshotSchema)
    .max(100)
    .superRefine((machines, context) => {
        const seenIds = new Set<string>();
        machines.forEach((machine, index) => {
            if (seenIds.has(machine.id)) {
                context.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: 'Duplicate machine ID in snapshot',
                });
            }
            seenIds.add(machine.id);
        });
    });

export const ApiSettingsResponseSchema = z.object({
    settings: EncryptedMetadataSchema.nullable(),
    settingsVersion: SafeNonnegativeIntegerSchema,
}).strict();

export const ApiSettingsUpdateResponseSchema = z.discriminatedUnion('success', [
    z.object({
        success: z.literal(true),
        version: SafeNonnegativeIntegerSchema,
    }).strict(),
    z.object({
        success: z.literal(false),
        error: z.literal('version-mismatch'),
        currentVersion: SafeNonnegativeIntegerSchema,
        currentSettings: EncryptedMetadataSchema.nullable(),
    }).strict(),
]);

export const ApiNativeVersionResponseSchema = z.object({
    updateUrl: z.null(),
}).strict();

const ApiPostSessionMessageSchema = z.object({
    id: IdSchema,
    seq: SafePositiveIntegerSchema,
    localId: IdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
}).strict();

export const ApiPostSessionMessagesResponseSchema = z.object({
    messages: z.array(ApiPostSessionMessageSchema).max(100),
}).strict().superRefine(({ messages }, context) => {
    const seenIds = new Set<string>();
    const seenSeqs = new Set<number>();
    const seenLocalIds = new Set<string>();
    messages.forEach((message, index) => {
        const duplicates: Array<[boolean, 'id' | 'seq' | 'localId']> = [
            [seenIds.has(message.id), 'id'],
            [seenSeqs.has(message.seq), 'seq'],
            [message.localId !== null && seenLocalIds.has(message.localId), 'localId'],
        ];
        for (const [duplicate, field] of duplicates) {
            if (duplicate) {
                context.addIssue({
                    code: 'custom',
                    path: ['messages', index, field],
                    message: `Duplicate message ${field}`,
                });
            }
        }
        seenIds.add(message.id);
        seenSeqs.add(message.seq);
        if (message.localId !== null) seenLocalIds.add(message.localId);
    });
});

export const ApiSessionSnapshotSchema = z.object({
    id: z.string().min(1).max(64),
    seq: SafeNonnegativeIntegerSchema,
    metadata: z.string().max(16_384),
    metadataVersion: SafeNonnegativeIntegerSchema,
    agentState: z.string().min(1).max(65_536).nullable(),
    agentStateVersion: SafeNonnegativeIntegerSchema,
    dataEncryptionKey: z.string().min(1).max(1_024).nullable(),
    active: z.boolean(),
    activeAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    lastMessage: ApiMessageSchema.nullable().optional(),
}).strict();

export const ApiSessionsResponseSchema = z.object({
    // The server endpoint is capped at 150. Enforce the same boundary before
    // doing key setup or authenticated field decryption.
    sessions: z.array(ApiSessionSnapshotSchema).max(150),
}).strict().superRefine(({ sessions }, context) => {
    const seenIds = new Set<string>();
    sessions.forEach((session, index) => {
        if (seenIds.has(session.id)) {
            context.addIssue({
                code: 'custom',
                path: ['sessions', index, 'id'],
                message: 'Duplicate session ID in snapshot',
            });
        }
        seenIds.add(session.id);
    });
});

export type ApiSessionSnapshot = z.infer<typeof ApiSessionSnapshotSchema>;
export type ApiMachineSnapshot = z.infer<typeof ApiMachineSnapshotSchema>;
export type ApiPostSessionMessagesResponse = z.infer<typeof ApiPostSessionMessagesResponseSchema>;

export {
    ApiMessageSchema,
    ApiUpdateMachineStateSchema,
    ApiUpdateNewMessageSchema,
    ApiUpdateSessionStateSchema,
};
export type { ApiMessage };

//
// Updates
//

export const ApiUpdateNewSessionSchema = z.object({
    t: z.literal('new-session'),
    id: IdSchema, // Session ID
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});

export const ApiDeleteSessionSchema = z.object({
    t: z.literal('delete-session'),
    sid: z.string().min(1).max(64), // Session ID
    recordCreatedAt: TimestampSchema.optional(),
});

export const ApiDeleteMachineSchema = z.object({
    t: z.literal('delete-machine'),
    machineId: IdSchema,
    recordCreatedAt: TimestampSchema.optional(),
});

// Machine creation. Carries the per-machine data encryption key so an
// already-connected app can register encryption and decrypt this machine's
// metadata/daemonState without waiting for a full /v1/machines refetch.
// Mirrors the server's buildNewMachineUpdate(). The companion 'update-machine'
// emit on creation is machine-scoped-only and never reaches the user's app, so
// 'new-machine' is the only machine-creation signal the app receives — it must
// be handled or freshly onboarded machines stay invisible until app restart.
export const ApiUpdateNewMachineSchema = z.object({
    t: z.literal('new-machine'),
    machineId: IdSchema,
    seq: SafeNonnegativeIntegerSchema,
    metadata: z.string().max(MAX_MACHINE_METADATA_CIPHERTEXT_CHARACTERS),
    metadataVersion: SafeNonnegativeIntegerSchema,
    daemonState: z.string().min(1).max(MAX_MACHINE_DAEMON_STATE_CIPHERTEXT_CHARACTERS).nullish(),
    daemonStateVersion: SafeNonnegativeIntegerSchema,
    dataEncryptionKey: TokenSchema.nullish(),
    active: z.boolean(),
    activeAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});

export const ApiUpdateAccountSchema = z.object({
    t: z.literal('update-account'),
    id: IdSchema,
    settings: z.object({
        value: EncryptedMetadataSchema.nullish(),
        version: SafeNonnegativeIntegerSchema
    }).nullish(),
    firstName: NameSchema.nullish(),
    lastName: NameSchema.nullish(),
    avatar: ImageRefSchema.nullish(),
    github: GitHubProfileSchema.nullish(),
});

// Artifact update schemas
export const ApiNewArtifactSchema = z.object({
    t: z.literal('new-artifact'),
    artifactId: IdSchema,
    header: EncryptedMetadataSchema,
    headerVersion: SafeNonnegativeIntegerSchema,
    body: EncryptedBlobSchema.optional(),
    bodyVersion: SafeNonnegativeIntegerSchema.optional(),
    dataEncryptionKey: TokenSchema,
    seq: SafeNonnegativeIntegerSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});

export const ApiUpdateArtifactSchema = z.object({
    t: z.literal('update-artifact'),
    artifactId: IdSchema,
    header: z.object({
        value: EncryptedMetadataSchema,
        version: SafeNonnegativeIntegerSchema,
    }).optional(),
    body: z.object({
        value: EncryptedBlobSchema,
        version: SafeNonnegativeIntegerSchema,
    }).optional()
});

export const ApiDeleteArtifactSchema = z.object({
    t: z.literal('delete-artifact'),
    artifactId: IdSchema,
    recordCreatedAt: TimestampSchema.optional(),
});

// KV batch update schema for real-time KV updates
export const ApiKvBatchUpdateSchema = z.object({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.object({
        key: TagSchema,
        value: EncryptedBlobSchema.nullable(),
        version: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    })).max(100)
});

// Use a plain union here to avoid runtime discriminator extraction issues
// when some schemas come from shared package exports.
export const ApiUpdateSchema = z.union([
    ApiUpdateNewMessageSchema,
    ApiUpdateNewSessionSchema,
    ApiDeleteSessionSchema,
    ApiUpdateSessionStateSchema,
    ApiUpdateAccountSchema,
    ApiUpdateMachineStateSchema,
    ApiUpdateNewMachineSchema,
    ApiDeleteMachineSchema,
    ApiNewArtifactSchema,
    ApiUpdateArtifactSchema,
    ApiDeleteArtifactSchema,
    ApiKvBatchUpdateSchema
]);

export type ApiUpdateNewMessage = z.infer<typeof ApiUpdateNewMessageSchema>;
export type ApiKvBatchUpdate = z.infer<typeof ApiKvBatchUpdateSchema>;
export type ApiUpdate = z.infer<typeof ApiUpdateSchema>;

//
// API update container
//

export const ApiUpdateContainerSchema = z.object({
    id: PersistentUpdateIdSchema,
    seq: SafePositiveIntegerSchema,
    body: ApiUpdateSchema,
    createdAt: TimestampSchema,
});

export type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

//
// Ephemeral update
//

export const ApiEphemeralActivityUpdateSchema = z.object({
    type: z.literal('activity'),
    id: IdSchema,
    active: z.boolean(),
    activeAt: TimestampSchema,
    thinking: z.boolean(),
});

export const ApiEphemeralUsageUpdateSchema = z.object({
    type: z.literal('usage'),
    id: IdSchema,
    key: TagSchema,
    timestamp: TimestampSchema,
    tokens: z.object({
        total: UsageTokenCountSchema,
        input: UsageTokenCountSchema,
        output: UsageTokenCountSchema,
        cache_creation: UsageTokenCountSchema,
        cache_read: UsageTokenCountSchema,
    }),
    cost: z.object({
        total: UsageCostSchema,
        input: UsageCostSchema,
        output: UsageCostSchema,
    }),
}).superRefine(({ tokens }, context) => {
    if (tokens.total !== tokens.input + tokens.output + tokens.cache_creation + tokens.cache_read) {
        context.addIssue({
            code: 'custom',
            path: ['tokens', 'total'],
            message: 'total must equal the token component sum',
        });
    }
});

export const ApiEphemeralMachineActivityUpdateSchema = z.object({
    type: z.literal('machine-activity'),
    id: IdSchema, // machine id
    active: z.boolean(),
    activeAt: TimestampSchema,
});

export const ApiEphemeralSessionEventUpdateSchema = z.object({
    type: z.literal('session-event'),
    sessionId: IdSchema,
    kind: z.enum(['done', 'permission', 'question']),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(500),
    timestamp: TimestampSchema,
});

export const ApiEphemeralUpdateSchema = z.union([
    ApiEphemeralActivityUpdateSchema,
    ApiEphemeralUsageUpdateSchema,
    ApiEphemeralMachineActivityUpdateSchema,
    ApiEphemeralSessionEventUpdateSchema,
]);

export type ApiEphemeralActivityUpdate = z.infer<typeof ApiEphemeralActivityUpdateSchema>;
export type ApiEphemeralUpdate = z.infer<typeof ApiEphemeralUpdateSchema>;

// Machine metadata updates use Partial<MachineMetadata> from storageTypes
// This matches how session metadata updates work
