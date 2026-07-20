import { eventRouter, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";
import { IdSchema, TokenSchema, EncryptedBlobSchema, EncryptedMetadataSchema } from "@/app/api/routes/_schemas";
import type { Prisma } from "@prisma/client";
import { createArtifactWithinQuota } from "@/app/artifacts/artifactCreate";
import { MAX_ARTIFACTS_PER_ACCOUNT } from "@/app/limits/persistedResourceQuotas";

export function artifactsRoutes(app: Fastify) {
    // GET /v1/artifacts - List all artifacts for the account
    app.get('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.array(z.object({
                    id: IdSchema,
                    header: EncryptedMetadataSchema,
                    headerVersion: z.number(),
                    dataEncryptionKey: TokenSchema,
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                })),
                500: z.object({
                    error: z.literal('Failed to get artifacts')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const artifacts = await db.artifact.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' },
                take: MAX_ARTIFACTS_PER_ACCOUNT,
                select: {
                    id: true,
                    header: true,
                    headerVersion: true,
                    dataEncryptionKey: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true
                }
            });

            return reply.send(artifacts.map(a => ({
                id: a.id,
                header: privacyKit.encodeBase64(a.header),
                headerVersion: a.headerVersion,
                dataEncryptionKey: privacyKit.encodeBase64(a.dataEncryptionKey),
                seq: a.seq,
                createdAt: a.createdAt.getTime(),
                updatedAt: a.updatedAt.getTime()
            })));
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to get artifacts');
            return reply.code(500).send({ error: 'Failed to get artifacts' });
        }
    });

    // GET /v1/artifacts/:id - Get single artifact with full body
    app.get('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: IdSchema
            }),
            response: {
                200: z.object({
                    id: IdSchema,
                    header: EncryptedMetadataSchema,
                    headerVersion: z.number(),
                    body: EncryptedBlobSchema,
                    bodyVersion: z.number(),
                    dataEncryptionKey: TokenSchema,
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const artifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to get artifact');
            return reply.code(500).send({ error: 'Failed to get artifact' });
        }
    });

    // POST /v1/artifacts - Create new artifact
    app.post('/v1/artifacts', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().uuid().max(64),
                header: EncryptedMetadataSchema,
                body: EncryptedBlobSchema,
                dataEncryptionKey: TokenSchema
            }),
            response: {
                200: z.object({
                    id: IdSchema,
                    header: EncryptedMetadataSchema,
                    headerVersion: z.number(),
                    body: EncryptedBlobSchema,
                    bodyVersion: z.number(),
                    dataEncryptionKey: TokenSchema,
                    seq: z.number(),
                    createdAt: z.number(),
                    updatedAt: z.number()
                }),
                409: z.object({
                    error: z.literal('Artifact with this ID already exists for another account')
                }),
                429: z.object({
                    error: z.literal('Artifact storage limit reached'),
                    code: z.literal('ARTIFACT_LIMIT_REACHED')
                }),
                500: z.object({
                    error: z.literal('Failed to create artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, header, body, dataEncryptionKey } = request.body;

        try {
            const createResult = await createArtifactWithinQuota(userId, {
                id,
                header: privacyKit.decodeBase64(header),
                body: privacyKit.decodeBase64(body),
                dataEncryptionKey: privacyKit.decodeBase64(dataEncryptionKey),
            });
            if (createResult.kind === 'conflict') {
                return reply.code(409).send({
                    error: 'Artifact with this ID already exists for another account'
                });
            }
            if (createResult.kind === 'limit') {
                return reply.code(429).send({
                    error: 'Artifact storage limit reached',
                    code: 'ARTIFACT_LIMIT_REACHED'
                });
            }
            const artifact = createResult.artifact;

            if (createResult.kind === 'created') {
                const updSeq = await allocateUserSeq(userId);
                const newArtifactPayload = buildNewArtifactUpdate(artifact, updSeq, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newArtifactPayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }

            return reply.send({
                id: artifact.id,
                header: privacyKit.encodeBase64(artifact.header),
                headerVersion: artifact.headerVersion,
                body: privacyKit.encodeBase64(artifact.body),
                bodyVersion: artifact.bodyVersion,
                dataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                seq: artifact.seq,
                createdAt: artifact.createdAt.getTime(),
                updatedAt: artifact.updatedAt.getTime()
            });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to create artifact');
            return reply.code(500).send({ error: 'Failed to create artifact' });
        }
    });

    // POST /v1/artifacts/:id - Update artifact with version control
    app.post('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: IdSchema
            }),
            body: z.object({
                header: EncryptedMetadataSchema.optional(),
                expectedHeaderVersion: z.number().int().min(0).optional(),
                body: EncryptedBlobSchema.optional(),
                expectedBodyVersion: z.number().int().min(0).optional()
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        headerVersion: z.number().optional(),
                        bodyVersion: z.number().optional()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentHeaderVersion: z.number().optional(),
                        currentBodyVersion: z.number().optional(),
                        currentHeader: EncryptedMetadataSchema.optional(),
                        currentBody: EncryptedBlobSchema.optional()
                    })
                ]),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to update artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { header, expectedHeaderVersion, body, expectedBodyVersion } = request.body;

        try {
            // Get current artifact for version check
            const currentArtifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!currentArtifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            // Check version mismatches
            const headerMismatch = header !== undefined && expectedHeaderVersion !== undefined &&
                                   currentArtifact.headerVersion !== expectedHeaderVersion;
            const bodyMismatch = body !== undefined && expectedBodyVersion !== undefined &&
                                 currentArtifact.bodyVersion !== expectedBodyVersion;

            if (headerMismatch || bodyMismatch) {
                return reply.send({
                    success: false,
                    error: 'version-mismatch',
                    ...(headerMismatch && {
                        currentHeaderVersion: currentArtifact.headerVersion,
                        currentHeader: privacyKit.encodeBase64(currentArtifact.header)
                    }),
                    ...(bodyMismatch && {
                        currentBodyVersion: currentArtifact.bodyVersion,
                        currentBody: privacyKit.encodeBase64(currentArtifact.body)
                    })
                });
            }

            // Build update data
            const updateData: Prisma.ArtifactUpdateManyMutationInput = {
                updatedAt: new Date()
            };

            let headerUpdate: { value: string; version: number } | undefined;
            let bodyUpdate: { value: string; version: number } | undefined;

            if (header !== undefined && expectedHeaderVersion !== undefined) {
                updateData.header = privacyKit.decodeBase64(header);
                updateData.headerVersion = expectedHeaderVersion + 1;
                headerUpdate = {
                    value: header,
                    version: expectedHeaderVersion + 1
                };
            }

            if (body !== undefined && expectedBodyVersion !== undefined) {
                updateData.body = privacyKit.decodeBase64(body);
                updateData.bodyVersion = expectedBodyVersion + 1;
                bodyUpdate = {
                    value: body,
                    version: expectedBodyVersion + 1
                };
            }

            // Increment seq
            // Header and body have independent versions, so independent writers
            // may both succeed. Increment the shared sequence atomically rather
            // than deriving it from the stale pre-write snapshot.
            updateData.seq = { increment: 1 };

            // Bind ownership and every supplied expected version to the write.
            // The earlier read exists only to produce a useful conflict response;
            // this predicate is the optimistic-concurrency control.
            const { count } = await db.artifact.updateMany({
                where: {
                    id,
                    accountId: userId,
                    ...(headerUpdate && { headerVersion: expectedHeaderVersion }),
                    ...(bodyUpdate && { bodyVersion: expectedBodyVersion }),
                },
                data: updateData
            });

            if (count === 0) {
                const latestArtifact = await db.artifact.findFirst({
                    where: { id, accountId: userId },
                });
                if (!latestArtifact) {
                    return reply.code(404).send({ error: 'Artifact not found' });
                }

                const latestHeaderMismatch = headerUpdate !== undefined &&
                    latestArtifact.headerVersion !== expectedHeaderVersion;
                const latestBodyMismatch = bodyUpdate !== undefined &&
                    latestArtifact.bodyVersion !== expectedBodyVersion;

                return reply.send({
                    success: false,
                    error: 'version-mismatch',
                    ...(latestHeaderMismatch && {
                        currentHeaderVersion: latestArtifact.headerVersion,
                        currentHeader: privacyKit.encodeBase64(latestArtifact.header),
                    }),
                    ...(latestBodyMismatch && {
                        currentBodyVersion: latestArtifact.bodyVersion,
                        currentBody: privacyKit.encodeBase64(latestArtifact.body),
                    }),
                });
            }

            // Emit update-artifact event
            const updSeq = await allocateUserSeq(userId);
            const updatePayload = buildUpdateArtifactUpdate(id, updSeq, randomKeyNaked(12), headerUpdate, bodyUpdate);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                ...(headerUpdate && { headerVersion: headerUpdate.version }),
                ...(bodyUpdate && { bodyVersion: bodyUpdate.version })
            });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to update artifact');
            return reply.code(500).send({ error: 'Failed to update artifact' });
        }
    });

    // DELETE /v1/artifacts/:id - Delete artifact
    app.delete('/v1/artifacts/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: IdSchema
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Artifact not found')
                }),
                500: z.object({
                    error: z.literal('Failed to delete artifact')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            // Check if artifact exists and belongs to user
            const artifact = await db.artifact.findFirst({
                where: {
                    id,
                    accountId: userId
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Artifact not found' });
            }

            // Delete artifact
            await db.artifact.delete({
                where: { id }
            });

            // Emit delete-artifact event
            const updSeq = await allocateUserSeq(userId);
            const deletePayload = buildDeleteArtifactUpdate(id, updSeq, randomKeyNaked(12), artifact.createdAt);
            eventRouter.emitUpdate({
                userId,
                payload: deletePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({ success: true });
        } catch {
            log({ module: 'api', level: 'error' }, 'Failed to delete artifact');
            return reply.code(500).send({ error: 'Failed to delete artifact' });
        }
    });
}
