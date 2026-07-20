import fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';

import {
    GLOBAL_BODY_LIMIT,
    getGlobalRateLimitKey,
    getSocketRateLimitKey,
    resolveAllowedOrigins,
} from './requestSecurity';

describe('HTTP request resource policy', () => {
    const apps: Array<ReturnType<typeof fastify>> = [];

    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
    });

    it('keeps ordinary public request bodies at one MiB', async () => {
        expect(GLOBAL_BODY_LIMIT).toBe(1024 * 1024);
        const app = fastify({ bodyLimit: GLOBAL_BODY_LIMIT });
        apps.push(app);
        app.post('/ordinary', async () => ({ ok: true }));

        const response = await app.inject({
            method: 'POST',
            url: '/ordinary',
            headers: { 'content-type': 'application/json' },
            payload: { value: 'x'.repeat(GLOBAL_BODY_LIMIT) },
        });

        expect(response.statusCode).toBe(413);
    });

    it('does not let rotating client-supplied CDN headers evade the global limiter', async () => {
        const app = fastify({ trustProxy: ['127.0.0.1', '::1'] });
        apps.push(app);
        await app.register(fastifyRateLimit, {
            max: 2,
            timeWindow: '1 minute',
            keyGenerator: getGlobalRateLimitKey,
        });
        app.get('/limited', async () => ({ ok: true }));

        const statuses: number[] = [];
        for (const fakeIp of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
            const response = await app.inject({
                method: 'GET',
                url: '/limited',
                remoteAddress: '203.0.113.10',
                headers: { 'cf-connecting-ip': fakeIp },
            });
            statuses.push(response.statusCode);
        }

        expect(statuses).toEqual([200, 200, 429]);
    });

    it('uses the transport peer for socket burst identity and ignores CDN headers', () => {
        const first = getSocketRateLimitKey({
            address: '203.0.113.10',
            headers: { 'cf-connecting-ip': '198.51.100.1' },
        });
        const second = getSocketRateLimitKey({
            address: '203.0.113.10',
            headers: { 'cf-connecting-ip': '198.51.100.2' },
        });

        expect(first).toBe('203.0.113.10');
        expect(second).toBe(first);
    });

    it('uses the rightmost forwarded client only behind the trusted loopback proxy', () => {
        expect(getSocketRateLimitKey({
            address: '127.0.0.1',
            headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.10' },
        })).toBe('203.0.113.10');
        expect(getSocketRateLimitKey({
            address: '192.0.2.20',
            headers: { 'x-forwarded-for': '198.51.100.1' },
        })).toBe('192.0.2.20');
    });
});

describe('CORS origin policy', () => {
    it('adds one exact HTTPS origin while preserving production and localhost clients', () => {
        const defaults = resolveAllowedOrigins();
        expect(defaults).toHaveLength(3);
        expect(defaults[0]).toMatch(/^https:\/\//);
        expect(resolveAllowedOrigins('https://idle-mini.example.ts.net')).toEqual([
            ...defaults,
            'https://idle-mini.example.ts.net',
        ]);
    });

    it.each([
        '*',
        'https://*.example.ts.net',
        'https://idle-mini.example.ts.net/path',
        ['https://user', ':pass@idle-mini.example.ts.net'].join(''),
        'http://idle-mini.example.ts.net',
    ])('rejects a non-exact or insecure configured origin: %s', (origin) => {
        expect(() => resolveAllowedOrigins(origin)).toThrow(/origin/i);
    });
});
