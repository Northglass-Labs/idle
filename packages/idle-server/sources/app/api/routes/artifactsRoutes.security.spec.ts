import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    dbMock,
    emitUpdateMock,
    createArtifactWithinQuotaMock,
    getArtifact,
    resetArtifact,
} = vi.hoisted(() => {
    let artifact: any;
    let initialReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    let initialReadsReady: Promise<void>;

    const resetArtifact = () => {
        artifact = {
            id: '00000000-0000-4000-8000-000000000001',
            accountId: 'owner-account',
            header: Buffer.from('old-header'),
            headerVersion: 1,
            body: Buffer.from('old-body'),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from('artifact-key'),
            seq: 0,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        };
        initialReads = 0;
        initialReadsReady = new Promise<void>((resolve) => {
            releaseInitialReads = resolve;
        });
    };

    resetArtifact();

    const matchesWhere = (where: any) => (
        artifact &&
        (where.id === undefined || artifact.id === where.id) &&
        (where.accountId === undefined || artifact.accountId === where.accountId) &&
        (where.headerVersion === undefined || artifact.headerVersion === where.headerVersion) &&
        (where.bodyVersion === undefined || artifact.bodyVersion === where.bodyVersion)
    );

    const applyData = (data: any) => {
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === 'object' && 'increment' in value) {
                artifact[key] += (value as { increment: number }).increment;
            } else {
                artifact[key] = value;
            }
        }
        return { ...artifact };
    };

    const dbMock = {
        artifact: {
            findFirst: vi.fn(async ({ where }: any) => {
                if (!matchesWhere(where)) return null;
                const snapshot = { ...artifact };
                initialReads += 1;
                if (initialReads <= 2) {
                    if (initialReads === 2) releaseInitialReads?.();
                    await initialReadsReady;
                }
                return snapshot;
            }),
            update: vi.fn(async ({ data }: any) => applyData(data)),
            updateMany: vi.fn(async ({ where, data }: any) => {
                if (!matchesWhere(where)) return { count: 0 };
                applyData(data);
                return { count: 1 };
            }),
        },
    };

    return {
        dbMock,
        emitUpdateMock: vi.fn(),
        createArtifactWithinQuotaMock: vi.fn(),
        getArtifact: () => ({ ...artifact }),
        resetArtifact,
    };
});

vi.mock('../../../storage/db', () => ({ db: dbMock }));
vi.mock('../../artifacts/artifactCreate', () => ({
    createArtifactWithinQuota: createArtifactWithinQuotaMock,
}));
vi.mock('../../../storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('../../../utils/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'update-id') }));
vi.mock('../../../utils/log', () => ({ log: vi.fn() }));
vi.mock('../../events/eventRouter', () => ({
    buildUpdateArtifactUpdate: vi.fn(() => ({ type: 'artifact-update' })),
    buildNewArtifactUpdate: vi.fn(),
    buildDeleteArtifactUpdate: vi.fn(),
    eventRouter: { emitUpdate: emitUpdateMock },
}));

import { artifactsRoutes } from './artifactsRoutes';

async function createApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'owner-account';
    });
    artifactsRoutes(typed);
    await typed.ready();
    return typed;
}

describe('artifact optimistic concurrency boundary', () => {
    let app: Fastify;

    beforeEach(async () => {
        vi.clearAllMocks();
        resetArtifact();
        createArtifactWithinQuotaMock.mockResolvedValue({ kind: 'limit' });
        app = await createApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('allows only one of two same-version header writes to commit', async () => {
        const request = (header: string) => app.inject({
            method: 'POST',
            url: '/v1/artifacts/00000000-0000-4000-8000-000000000001',
            payload: { header, expectedHeaderVersion: 1 },
        });

        const responses = await Promise.all([
            request(Buffer.from('first-header').toString('base64')),
            request(Buffer.from('second-header').toString('base64')),
        ]);
        const bodies = responses.map((response) => response.json());

        expect(bodies.filter((body) => body.success === true)).toHaveLength(1);
        expect(bodies.filter((body) => body.error === 'version-mismatch')).toEqual([
            expect.objectContaining({
                success: false,
                currentHeaderVersion: 2,
            }),
        ]);
        expect(dbMock.artifact.updateMany).toHaveBeenCalledTimes(2);
        expect(dbMock.artifact.update).not.toHaveBeenCalled();
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });

    it('preserves concurrent updates to independently versioned header and body fields', async () => {
        const [headerResponse, bodyResponse] = await Promise.all([
            app.inject({
                method: 'POST',
                url: '/v1/artifacts/00000000-0000-4000-8000-000000000001',
                payload: {
                    header: Buffer.from('new-header').toString('base64'),
                    expectedHeaderVersion: 1,
                },
            }),
            app.inject({
                method: 'POST',
                url: '/v1/artifacts/00000000-0000-4000-8000-000000000001',
                payload: {
                    body: Buffer.from('new-body').toString('base64'),
                    expectedBodyVersion: 1,
                },
            }),
        ]);

        expect(headerResponse.json()).toEqual({ success: true, headerVersion: 2 });
        expect(bodyResponse.json()).toEqual({ success: true, bodyVersion: 2 });
        expect(getArtifact()).toEqual(expect.objectContaining({
            headerVersion: 2,
            bodyVersion: 2,
            seq: 2,
        }));
        expect(emitUpdateMock).toHaveBeenCalledTimes(2);
    });

    it('maps the durable artifact cap to a stable 429 without allocating a row', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: {
                id: '00000000-0000-4000-8000-000000000002',
                header: Buffer.from('header').toString('base64'),
                body: Buffer.from('body').toString('base64'),
                dataEncryptionKey: Buffer.from('key').toString('base64'),
            },
        });

        expect(response.statusCode).toBe(429);
        expect(response.json()).toEqual({
            error: 'Artifact storage limit reached',
            code: 'ARTIFACT_LIMIT_REACHED',
        });
        expect(createArtifactWithinQuotaMock).toHaveBeenCalledTimes(1);
    });
});
