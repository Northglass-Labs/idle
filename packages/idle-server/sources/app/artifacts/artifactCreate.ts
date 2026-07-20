import type { Artifact } from '@prisma/client';

import { canAllocateArtifactRows, isUniqueConstraintError } from '../limits/persistedResourceQuotas';
import { inTx } from '../../storage/inTx';

export interface ArtifactCreateInput {
    id: string;
    header: Uint8Array;
    body: Uint8Array;
    dataEncryptionKey: Uint8Array;
}

export type ArtifactCreateResult =
    | { kind: 'created'; artifact: Artifact }
    | { kind: 'existing'; artifact: Artifact }
    | { kind: 'conflict' }
    | { kind: 'limit' };

function classifyExisting(accountId: string, artifact: Artifact): ArtifactCreateResult {
    return artifact.accountId === accountId
        ? { kind: 'existing', artifact }
        : { kind: 'conflict' };
}

/**
 * Allocate an encrypted artifact under one Serializable publication boundary.
 * Same-account retries remain idempotent even when the account is already at
 * its cap; a new row is the only operation that consumes capacity.
 */
export async function createArtifactWithinQuota(
    accountId: string,
    input: ArtifactCreateInput,
): Promise<ArtifactCreateResult> {
    try {
        return await inTx(async (tx) => {
            const existing = await tx.artifact.findUnique({ where: { id: input.id } });
            if (existing) {
                return classifyExisting(accountId, existing);
            }

            if (!await canAllocateArtifactRows(tx, accountId, 1)) {
                return { kind: 'limit' as const };
            }

            const artifact = await tx.artifact.create({
                data: {
                    id: input.id,
                    accountId,
                    header: Uint8Array.from(input.header),
                    headerVersion: 1,
                    body: Uint8Array.from(input.body),
                    bodyVersion: 1,
                    dataEncryptionKey: Uint8Array.from(input.dataEncryptionKey),
                    seq: 0,
                },
            });
            return { kind: 'created' as const, artifact };
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) {
            throw error;
        }

        // A same-ID writer may win after our initial read. Re-read in a fresh
        // transaction because the unique violation aborts the original one.
        return inTx(async (tx) => {
            const existing = await tx.artifact.findUnique({ where: { id: input.id } });
            if (!existing) throw error;
            return classifyExisting(accountId, existing);
        });
    }
}
