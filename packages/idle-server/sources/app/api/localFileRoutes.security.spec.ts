import { Readable } from 'stream';
import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { filesMock } = vi.hoisted(() => ({
    filesMock: {
        isLocalStorage: vi.fn(() => true),
        isPublicLocalFileKey: vi.fn((key: string) => key.startsWith('public/') && !key.split('/').includes('..')),
        createLocalFileReadStream: vi.fn((key: string) => Readable.from(Buffer.from(`public:${key}`))),
    },
}));

vi.mock('../../storage/files', () => filesMock);

import { registerLocalFileRoutes } from './localFileRoutes';

describe('local public-file route boundary', () => {
    beforeEach(() => vi.clearAllMocks());

    it('never exposes session attachments through the possession-based public route', async () => {
        const app = fastify();
        registerLocalFileRoutes(app as any);

        const response = await app.inject({
            method: 'GET',
            url: '/files/sessions/session-1/attachments/11111111-1111-4111-8111-111111111111.enc',
        });

        expect(response.statusCode).toBe(404);
        expect(filesMock.createLocalFileReadStream).not.toHaveBeenCalled();
        await app.close();
    });

    it('continues serving the explicit public image namespace', async () => {
        const app = fastify();
        registerLocalFileRoutes(app as any);

        const response = await app.inject({
            method: 'GET',
            url: '/files/public/users/account-1/avatars/avatar.jpg',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('public:public/users/account-1/avatars/avatar.jpg');
        await app.close();
    });

    it('rejects encoded traversal before opening a file', async () => {
        const app = fastify();
        registerLocalFileRoutes(app as any);

        const response = await app.inject({ method: 'GET', url: '/files/public/%2e%2e/secret' });

        expect(response.statusCode).toBe(404);
        expect(filesMock.createLocalFileReadStream).not.toHaveBeenCalled();
        await app.close();
    });
});
