import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";

type MetricsRouteRequest = {
    routeOptions?: { url?: string };
    url: string;
};

export function getMetricsRoute(request: MetricsRouteRequest): string {
    const route = request.routeOptions?.url;
    return typeof route === 'string' && route.length > 0 && route.length <= 256
        ? route
        : 'unmatched';
}

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Only registered templates are safe metric labels. A raw unmatched URL
        // is attacker-controlled and creates unbounded label cardinality.
        const route = getMetricsRoute(request);
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
    });

    app.get('/health', async (request, reply) => {
        try {
            // Test database connectivity
            await db.$queryRaw`SELECT 1`;
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'idle-server'
            });
        } catch {
            log({ module: 'health', level: 'error' }, 'Health check failed');
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'idle-server',
                error: 'Database connectivity failed'
            });
        }
    });
}
