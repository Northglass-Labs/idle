import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { registerIdleRoutes } from "./idleRoutes";
import { db } from "@/storage/db";
import * as path from "path";
import * as fs from "fs";
import { createInlineConfigScript, type IdleInjectedHtmlConfig } from "./inlineConfig";
import { registerLocalFileRoutes } from "./localFileRoutes";
import {
    GLOBAL_BODY_LIMIT,
    getGlobalRateLimitKey,
    resolveAllowedOrigins,
} from "./requestSecurity";
import { pairingRequestCutoff } from "@/app/auth/pairingRequestPolicy";
import {
    contentSecurityPolicyForRequest,
    isRuntimeConfiguredHtmlResponse,
    isStaticWebRequest,
} from "./contentSecurityPolicy";
import { safeRequestLogFields } from "./requestLogging";

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: IdleInjectedHtmlConfig;
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');

    // Start API.
    //
    // Trust only a loopback reverse proxy. The rate limiter uses Fastify's
    // derived request.ip; raw forwarding headers from direct clients never
    // select the source-identity bucket.
    const app = fastify({
        disableRequestLogging: true,
        loggerInstance: logger,
        bodyLimit: GLOBAL_BODY_LIMIT,
        trustProxy: ['127.0.0.1', '::1'],
    });
    app.addHook('onResponse', async (request, reply) => {
        const fields = safeRequestLogFields({
            elapsedMs: reply.elapsedTime,
            method: request.method,
            routeTemplate: request.routeOptions.url,
            statusCode: reply.statusCode,
        });
        log({
            durationBucket: fields.durationBucket,
            httpMethod: fields.httpMethod,
            module: fields.module,
            routeTemplate: fields.routeTemplate,
            statusCode: fields.statusCode,
        }, 'HTTP request completed');
    });
    const injectScript = createInlineConfigScript(opts.injectHtmlConfig);
    const allowedOrigins = resolveAllowedOrigins();
    // Type casts needed: @fastify/rate-limit augments FastifyInstance globally,
    // causing type conflicts when registering other plugins before rate-limit.
    await app.register(fastifyCors as any, {
        origin: allowedOrigins,
        // Keep the legacy wire header accepted so older Idle clients can
        // complete CORS preflight during upgrades.
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Happy-Client'],
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    });

    // Security headers — X-Frame-Options, X-Content-Type-Options, HSTS, etc.
    // CSP is assigned below because bundled web assets need a different policy
    // from JSON APIs and the exact runtime-config script hash is request-local.
    await app.register(fastifyHelmet as any, {
        contentSecurityPolicy: false,
    });
    app.addHook('onSend', async (request, reply, payload) => {
        // Individual surfaces may deliberately install a stricter policy. The
        // operator panel does so; never broaden one here.
        if (!reply.hasHeader('content-security-policy')) {
            reply.header('Content-Security-Policy', contentSecurityPolicyForRequest({
                hasStaticWebApp: !!opts.staticDir,
                method: request.method,
                url: request.raw.url || '',
                injectScript,
            }));
        }
        return payload;
    });

    // Rate limiting — stricter on auth endpoints, relaxed elsewhere.
    // `request.ip` is derived from the socket peer and the explicitly trusted
    // loopback proxy. A direct caller cannot rotate raw CDN headers to evade
    // this global bucket.
    await app.register(fastifyRateLimit as any, {
        max: 100,               // Default: 100 requests per window
        timeWindow: '1 minute',
        keyGenerator: getGlobalRateLimitKey,
    });
    // Required for local-mode attachment uploads. Pass the request stream
    // through only after the route's preParsing capability/byte admission;
    // the route counts bytes while writing instead of buffering a full blob.
    app.addContentTypeParser(
        'application/octet-stream',
        (_req, body, done) => done(null, body),
    );

    // Root handler — when not serving a static webapp, return a banner.
    // When serving a static webapp, @fastify/static handles `/` via its index.
    if (!opts.staticDir) {
        app.get('/', function (request, reply) {
            reply.send('Welcome to Idle Server!');
        });
    }

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed, { skipNotFoundHandler: !!opts.staticDir });
    enableAuthentication(typed);

    registerLocalFileRoutes(typed);

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    kvRoutes(typed);
    v3SessionRoutes(typed);
    attachmentRoutes(typed);

    // Idle-owned modules share one reviewed registration boundary. Each module
    // remains responsible for its own authentication and fail-closed defaults.
    registerIdleRoutes(typed);

    // Static webapp (self-host mode)
    if (opts.staticDir) {
        const fastifyStatic = (await import('@fastify/static')).default;
        app.register(fastifyStatic, {
            root: opts.staticDir,
            prefix: '/',
            decorateReply: false,
            // SPA fallback — if file not found, serve index.html
            wildcard: false,
        });
        if (injectScript) {
            app.addHook('onSend', async (request, reply, payload) => {
                const url = request.raw.url || '';
                const contentType = reply.getHeader('content-type');
                if (!isRuntimeConfiguredHtmlResponse(url, contentType, injectScript)) return payload;
                let html: string;
                if (typeof payload === 'string') {
                    html = payload;
                } else if (Buffer.isBuffer(payload)) {
                    html = payload.toString('utf8');
                } else if (payload && typeof (payload as any).pipe === 'function') {
                    // stream — read it
                    const chunks: Buffer[] = [];
                    for await (const chunk of payload as any) {
                        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    }
                    html = Buffer.concat(chunks).toString('utf8');
                } else {
                    return payload;
                }
                const injected = html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`);
                reply.header('Cache-Control', 'no-store');
                reply.header('Pragma', 'no-cache');
                reply.header('content-length', Buffer.byteLength(injected));
                return injected;
            });
        }
        // SPA fallback: serve index.html for any unmatched GET that looks like a route.
        app.setNotFoundHandler(async (request, reply) => {
            const url = request.raw.url || '';
            // Unknown API, operator, socket, and file paths must never turn
            // into a successful HTML response through the SPA fallback.
            if (!isStaticWebRequest({ hasStaticWebApp: true, method: request.method, url })) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(opts.staticDir!, 'index.html');
            if (!fs.existsSync(indexPath)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const html = fs.readFileSync(indexPath, 'utf8');
            const injected = injectScript ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`) : html;
            if (injectScript) {
                reply.header('Cache-Control', 'no-store');
                reply.header('Pragma', 'no-cache');
            }
            reply.type('text/html').send(injected);
        });
    }

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    // Loopback-only by default — production fronts this with a reverse proxy that
    // talks to 127.0.0.1:3005, so the listener does not need a public bind. Operators
    // running without a fronting proxy can explicitly set HOST or pass opts.host;
    // the default keeps direct network exposure opt-in.
    const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // Cleanup stale pending and approved terminal/account pairing rows. Approval
    // and redemption routes enforce the same shared lifetime, so this timer is
    // retention hygiene rather than an authorization boundary. Combined with
    // the per-route rate limit on /v1/auth/request (10/min/IP),
    // this caps both the rate AND the steady-state size of the table — so a
    // pre-auth attacker can't DOS the DB by spamming fresh keypairs.
    // Window: 5 minutes. The pairing handshake completes in seconds; any row
    // older than that has been abandoned.
    const cleanupInterval = setInterval(async () => {
        try {
            const cutoff = pairingRequestCutoff();
            const [terminal, account, repeatKeys] = await Promise.all([
                db.terminalAuthRequest.deleteMany({
                    where: { createdAt: { lt: cutoff } },
                }),
                db.accountAuthRequest.deleteMany({
                    where: { createdAt: { lt: cutoff } },
                }),
                db.repeatKey.deleteMany({
                    where: { expiresAt: { lt: new Date() } },
                }),
            ]);
            const count = terminal.count + account.count + repeatKeys.count;
            if (count > 0) {
                log({ module: 'auth-cleanup', deletedCount: count }, 'Purged stale authentication records');
            }
        } catch (err) {
            log({ module: 'auth-cleanup', level: 'error' }, 'Authentication cleanup failed');
        }
    }, 60 * 1000);
    onShutdown('auth-cleanup', async () => {
        clearInterval(cleanupInterval);
    });

    // Start Socket
    startSocket(typed, allowedOrigins);

    // End
    log({ module: 'api' }, 'API ready');
    return { port, host };
}
