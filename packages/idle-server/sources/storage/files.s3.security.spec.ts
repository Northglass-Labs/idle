import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { s3Mock, ClientMock } = vi.hoisted(() => {
    const s3Mock = {
        statObject: vi.fn(),
        removeObjects: vi.fn().mockResolvedValue(undefined),
        bucketExists: vi.fn().mockResolvedValue(true),
    };
    return { s3Mock, ClientMock: vi.fn(() => s3Mock) };
});

vi.mock('minio', () => ({ Client: ClientMock }));

function ref(index: number): string {
    const suffix = index.toString(16).padStart(12, '0');
    return `sessions/session-1/attachments/11111111-1111-4111-8111-${suffix}.enc`;
}

describe('S3 attachment object boundary', () => {
    let files: typeof import('./files');

    beforeEach(async () => {
        vi.clearAllMocks();
        s3Mock.removeObjects.mockResolvedValue(undefined);
        process.env.S3_HOST = 's3.example.test';
        process.env.S3_BUCKET = 'idle-test';
        process.env.S3_PUBLIC_URL = 'https://objects.example.test';
        process.env.S3_ACCESS_KEY = 'test';
        process.env.S3_SECRET_KEY = 'test';
        vi.resetModules();
        files = await import('./files');
    });

    afterEach(() => {
        delete process.env.S3_HOST;
        delete process.env.S3_BUCKET;
        delete process.env.S3_PUBLIC_URL;
        delete process.env.S3_ACCESS_KEY;
        delete process.env.S3_SECRET_KEY;
    });

    it('stats exactly one database-owned object key without listing a prefix', async () => {
        s3Mock.statObject.mockResolvedValue({ size: 4096 });

        await expect(files.statAttachmentObject(ref(1))).resolves.toEqual({ size: 4096 });

        expect(s3Mock.statObject).toHaveBeenCalledWith('idle-test', ref(1));
        expect((s3Mock as any).listObjects).toBeUndefined();
    });

    it('returns missing for an exact object-not-found response', async () => {
        s3Mock.statObject.mockRejectedValue(Object.assign(new Error('missing'), { code: 'NoSuchKey' }));

        await expect(files.statAttachmentObject(ref(2))).resolves.toBeNull();
    });

    it('deletes exact database refs in bounded batches and never lists storage', async () => {
        const refs = Array.from({ length: 205 }, (_, index) => ref(index));

        await files.deleteAttachmentObjects(refs);

        expect(s3Mock.removeObjects).toHaveBeenCalledTimes(3);
        expect(s3Mock.removeObjects.mock.calls.map((call) => call[1].length)).toEqual([100, 100, 5]);
        expect((s3Mock as any).listObjects).toBeUndefined();
    });

    it('fails closed before touching S3 if a delete batch exceeds the account cap', async () => {
        const refs = Array.from({ length: 2_001 }, (_, index) => ref(index));

        await expect(files.deleteAttachmentObjects(refs)).rejects.toThrow(/exceeds account quota/i);
        expect(s3Mock.removeObjects).not.toHaveBeenCalled();
    });
});
