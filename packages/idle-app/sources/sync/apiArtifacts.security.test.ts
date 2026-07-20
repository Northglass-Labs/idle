import { describe, expect, it } from 'vitest';
import {
    ArtifactCreateRequestSchema,
    ArtifactFullResponseSchema,
    ArtifactListResponseSchema,
    ArtifactUpdateRequestSchema,
    ArtifactUpdateResponseSchema,
} from './artifactTypes';

const listArtifact = {
    id: '00000000-0000-4000-8000-000000000001',
    header: 'encrypted-header',
    headerVersion: 1,
    dataEncryptionKey: 'encrypted-key',
    seq: 1,
    createdAt: 1,
    updatedAt: 2,
};

describe('artifact API contracts', () => {
    it('accepts the bounded list and full response shapes', () => {
        expect(ArtifactListResponseSchema.safeParse([listArtifact]).success).toBe(true);
        expect(ArtifactFullResponseSchema.safeParse({
            ...listArtifact,
            body: 'encrypted-body',
            bodyVersion: 1,
        }).success).toBe(true);
    });

    it('rejects unknown fields, list bodies, and oversized inventories', () => {
        expect(ArtifactListResponseSchema.safeParse([{ ...listArtifact, attacker: true }]).success).toBe(false);
        expect(ArtifactListResponseSchema.safeParse([{ ...listArtifact, body: 'encrypted-body' }]).success).toBe(false);
        expect(ArtifactListResponseSchema.safeParse(
            Array.from({ length: 201 }, (_, index) => ({ ...listArtifact, id: `artifact-${index}` })),
        ).success).toBe(false);
        expect(ArtifactFullResponseSchema.safeParse({
            ...listArtifact,
            body: 'x'.repeat(65_537),
            bodyVersion: 1,
        }).success).toBe(false);
    });

    it('validates create and paired optimistic-update inputs', () => {
        expect(ArtifactCreateRequestSchema.safeParse({
            id: listArtifact.id,
            header: listArtifact.header,
            body: 'encrypted-body',
            dataEncryptionKey: listArtifact.dataEncryptionKey,
        }).success).toBe(true);
        expect(ArtifactCreateRequestSchema.safeParse({
            id: '../sessions',
            header: listArtifact.header,
            body: 'encrypted-body',
            dataEncryptionKey: listArtifact.dataEncryptionKey,
        }).success).toBe(false);
        expect(ArtifactUpdateRequestSchema.safeParse({ header: 'next-header' }).success).toBe(false);
        expect(ArtifactUpdateRequestSchema.safeParse({
            header: 'next-header',
            expectedHeaderVersion: 1,
        }).success).toBe(true);
    });

    it('strictly validates both update response variants', () => {
        expect(ArtifactUpdateResponseSchema.safeParse({ success: true, headerVersion: 2 }).success).toBe(true);
        expect(ArtifactUpdateResponseSchema.safeParse({
            success: false,
            error: 'version-mismatch',
            currentHeaderVersion: 2,
            currentHeader: 'current-header',
        }).success).toBe(true);
        expect(ArtifactUpdateResponseSchema.safeParse({ success: true, attacker: true }).success).toBe(false);
        expect(ArtifactUpdateResponseSchema.safeParse({ success: false, error: 'other' }).success).toBe(false);
    });
});
