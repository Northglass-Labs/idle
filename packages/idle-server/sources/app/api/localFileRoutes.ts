import type { Fastify } from './types';
import {
    createLocalFileReadStream,
    isLocalStorage,
    isPublicLocalFileKey,
} from '@/storage/files';

export function registerLocalFileRoutes(app: Fastify): void {
    if (!isLocalStorage()) return;

    app.get('/files/*', async (request, reply) => {
        const filePath = (request.params as Record<string, string>)['*'];
        if (!isPublicLocalFileKey(filePath)) {
            return reply.code(404).send('Not found');
        }
        try {
            return reply.send(createLocalFileReadStream(filePath));
        } catch {
            return reply.code(404).send('Not found');
        }
    });
}
