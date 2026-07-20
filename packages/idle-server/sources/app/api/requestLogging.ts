const ALLOWED_HTTP_METHODS = new Set([
    'DELETE',
    'GET',
    'HEAD',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
]);

const ROUTE_SEGMENT = /^(?:[A-Za-z0-9._*-]+|:[A-Za-z][A-Za-z0-9_]*\??)$/;

export interface RequestLogInput {
    elapsedMs: unknown;
    method: unknown;
    routeTemplate: unknown;
    statusCode: unknown;
}

function safeMethod(value: unknown): string {
    if (typeof value !== 'string') return 'OTHER';
    const method = value.toUpperCase();
    return ALLOWED_HTTP_METHODS.has(method) ? method : 'OTHER';
}

function safeRouteTemplate(value: unknown): string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
        return 'unmatched';
    }
    if (value === '/') return value;
    if (!value.startsWith('/')) return 'unmatched';
    const segments = value.slice(1).split('/');
    return segments.every((segment) => ROUTE_SEGMENT.test(segment))
        ? value
        : 'unmatched';
}

function safeStatusCode(value: unknown): number {
    return typeof value === 'number'
        && Number.isInteger(value)
        && value >= 100
        && value <= 599
        ? value
        : 0;
}

function durationBucket(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
    if (value < 10) return 'under-10ms';
    if (value < 50) return '10-49ms';
    if (value < 250) return '50-249ms';
    if (value < 1000) return '250-999ms';
    return '1s-or-more';
}

export function safeRequestLogFields(input: RequestLogInput) {
    return {
        durationBucket: durationBucket(input.elapsedMs),
        httpMethod: safeMethod(input.method),
        module: 'http',
        routeTemplate: safeRouteTemplate(input.routeTemplate),
        statusCode: safeStatusCode(input.statusCode),
    } as const;
}
