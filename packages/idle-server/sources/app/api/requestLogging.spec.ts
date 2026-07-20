import { describe, expect, it } from 'vitest';
import { safeRequestLogFields } from './requestLogging';

describe('bounded production request logging', () => {
    it('keeps only useful categorical request metadata', () => {
        expect(safeRequestLogFields({
            elapsedMs: 42,
            method: 'post',
            routeTemplate: '/v1/sessions/:id/messages',
            statusCode: 201,
        })).toEqual({
            durationBucket: '10-49ms',
            httpMethod: 'POST',
            module: 'http',
            routeTemplate: '/v1/sessions/:id/messages',
            statusCode: 201,
        });
    });

    it('fails closed for caller-controlled or malformed values', () => {
        expect(safeRequestLogFields({
            elapsedMs: Number.POSITIVE_INFINITY,
            method: 'CUSTOM secret',
            routeTemplate: '/v1/sessions/private-value?token=secret',
            statusCode: 999,
        })).toEqual({
            durationBucket: 'unknown',
            httpMethod: 'OTHER',
            module: 'http',
            routeTemplate: 'unmatched',
            statusCode: 0,
        });
    });

    it.each([
        [-1, 'unknown'],
        [0, 'under-10ms'],
        [9.99, 'under-10ms'],
        [10, '10-49ms'],
        [49.99, '10-49ms'],
        [50, '50-249ms'],
        [249.99, '50-249ms'],
        [250, '250-999ms'],
        [999.99, '250-999ms'],
        [1000, '1s-or-more'],
    ])('buckets duration %s without logging precise timing', (elapsedMs, expected) => {
        expect(safeRequestLogFields({
            elapsedMs,
            method: 'GET',
            routeTemplate: '/health',
            statusCode: 200,
        }).durationBucket).toBe(expected);
    });
});
