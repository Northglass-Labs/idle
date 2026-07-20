import fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '../types';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock('../../../utils/log', () => ({ log }));

import { enableErrorHandlers } from './enableErrorHandlers';

describe('HTTP error logging severity', () => {
    const apps: Array<ReturnType<typeof fastify>> = [];

    afterEach(async () => {
        log.mockReset();
        await Promise.all(apps.splice(0).map((app) => app.close()));
    });

    it('records an expected rate-limit rejection as a warning, not an unhandled error', async () => {
        const app = fastify();
        apps.push(app);
        await app.register(fastifyRateLimit, { max: 1, timeWindow: '1 minute' });
        enableErrorHandlers(app as unknown as Fastify);
        app.get('/limited', async () => ({ ok: true }));

        expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/limited' })).statusCode).toBe(429);

        const rejectionLogs = log.mock.calls.filter(([fields]) => fields?.statusCode === 429);
        expect(rejectionLogs.length).toBeGreaterThan(0);
        expect(rejectionLogs.every(([fields]) => fields.level === 'warn')).toBe(true);
        expect(rejectionLogs.map(([, message]) => message)).not.toContain('Unhandled request error');
    });
});
