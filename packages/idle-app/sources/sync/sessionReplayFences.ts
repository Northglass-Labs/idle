import { z } from 'zod';

export const MAX_PERSISTED_SESSION_REPLAY_FENCES = 4_096;

const SafeNonnegativeIntegerSchema = z.number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER);

export const SessionReplayFenceSchema = z.object({
    sessionId: z.string().min(1).max(64),
    createdAt: SafeNonnegativeIntegerSchema,
    metadataVersion: SafeNonnegativeIntegerSchema,
    metadataCiphertextCommitment: z.string().min(1).max(256).nullable(),
    agentStateVersion: SafeNonnegativeIntegerSchema,
    agentStateCiphertextCommitment: z.string().min(1).max(256).nullable(),
    // The highest message whose authenticated plaintext identity and outer
    // ciphertext coordinates were accepted by this device. Defaults preserve
    // compatibility with pre-floor v2 payloads without overstating freshness.
    messageSeq: SafeNonnegativeIntegerSchema.default(0),
    messageCiphertextCommitment: z.string().min(1).max(256).nullable().default(null),
    dataKeyFingerprint: z.string().min(1).max(256),
}).strict().superRefine((fence, context) => {
    if ((fence.messageSeq === 0) !== (fence.messageCiphertextCommitment === null)) {
        context.addIssue({
            code: 'custom',
            path: ['messageCiphertextCommitment'],
            message: 'Message replay floor requires both sequence and commitment',
        });
    }
});

export type SessionReplayFence = z.infer<typeof SessionReplayFenceSchema>;

export const SessionDeletionTombstoneSchema = z.object({
    sessionId: z.string().min(1).max(64),
    recordCreatedAt: SafeNonnegativeIntegerSchema,
}).strict();

function addDuplicateIssues(
    payload: {
        sessions: readonly { sessionId: string }[];
        tombstones: readonly { sessionId: string }[];
    },
    context: z.RefinementCtx,
): void {
    const seen = new Set<string>();
    for (const [collection, entries] of [
        ['sessions', payload.sessions],
        ['tombstones', payload.tombstones],
    ] as const) {
        entries.forEach((entry, index) => {
            if (seen.has(entry.sessionId)) {
                context.addIssue({
                    code: 'custom',
                    path: [collection, index, 'sessionId'],
                    message: 'Duplicate session replay-fence ID',
                });
            }
            seen.add(entry.sessionId);
        });
    }
}

export const SessionReplayFencePayloadSchema = z.object({
    version: z.literal(2),
    accountCommitment: z.string().min(1).max(256),
    epoch: SafeNonnegativeIntegerSchema.refine((value) => value > 0),
    sessions: z.array(SessionReplayFenceSchema)
        .max(MAX_PERSISTED_SESSION_REPLAY_FENCES),
    tombstones: z.array(SessionDeletionTombstoneSchema)
        .max(MAX_PERSISTED_SESSION_REPLAY_FENCES),
    tombstonesSaturated: z.boolean(),
}).strict().superRefine((payload, context) => {
    addDuplicateIssues(payload, context);
});

export type SessionReplayFencePayload = z.infer<typeof SessionReplayFencePayloadSchema>;
