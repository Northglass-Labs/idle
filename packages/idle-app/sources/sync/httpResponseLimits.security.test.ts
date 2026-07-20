import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
    return readFileSync(new URL(file, import.meta.url), 'utf8');
}

describe('HTTP response allocation boundary', () => {
    it('streams and byte-bounds every automatic account snapshot before JSON parsing', () => {
        const syncSource = source('./sync.ts');

        expect(syncSource).not.toMatch(/await\s+response\.json\(\)/);
        expect(syncSource).toContain('readBoundedJsonResponse(');
        expect(syncSource).toContain('streamingFetch(');
        expect(syncSource).toContain('ApiMachinesResponseSchema.parse(');
        expect(syncSource).toContain('ApiSettingsResponseSchema.parse(');
        expect(syncSource).toContain('ApiSettingsUpdateResponseSchema.parse(');
        expect(syncSource).toContain('ProfileSchema.parse(');
        expect(syncSource).toContain('ApiNativeVersionResponseSchema.parse(');
        expect(syncSource).toContain('ApiPostSessionMessagesResponseSchema.parse(');
        expect(syncSource).not.toMatch(/\)\s+as\s+(?:Array<|V3PostSessionMessagesResponse|\{\s*settings:)/);
    });

    it('streams and byte-bounds the automatic artifact inventory', () => {
        const artifactSource = source('./apiArtifacts.ts');

        expect(artifactSource).not.toMatch(/\.json\(\)/);
        expect(artifactSource).toContain('readBoundedJsonResponse(');
        expect(artifactSource).toContain('streamingFetch(');
        expect(artifactSource).toContain('ArtifactListResponseSchema.parse(');
        expect(artifactSource).toContain('ArtifactFullResponseSchema.parse(');
        expect(artifactSource).toContain('ArtifactUpdateResponseSchema.parse(');
        expect(artifactSource).not.toMatch(/\)\s+as\s+Artifact/);
    });

    it('streams and byte-bounds usage history queries', () => {
        const usageSource = source('./apiUsage.ts');

        expect(usageSource).not.toMatch(/\.json\(\)/);
        expect(usageSource).toContain('readBoundedJsonResponse(');
        expect(usageSource).toContain('streamingFetch(');
        expect(usageSource).toContain('UsageResponseSchema.parse(');
        expect(usageSource).not.toMatch(/\)\s+as\s+UsageResponse/);
    });

    it('has no shipped network consumer that allocates an unbounded response body', () => {
        const networkConsumers = [
            './apiAttachments.ts',
            './apiGithub.ts',
            './apiKv.ts',
            './apiPush.ts',
            './apiVoice.ts',
            './ops.ts',
            '../utils/readFileBytes.web.ts',
            '../app/(app)/server.tsx',
        ];

        for (const file of networkConsumers) {
            const fileSource = source(file);
            expect(fileSource, file).not.toMatch(/\.(?:json|text|arrayBuffer)\(\)/);
        }
    });
});
