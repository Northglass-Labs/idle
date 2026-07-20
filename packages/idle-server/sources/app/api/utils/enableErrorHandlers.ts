import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

function errorLogLevel(statusCode: number): 'warn' | 'error' {
    return statusCode < 500 ? 'warn' : 'error';
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
        const method = request.method;
        const statusCode = error.statusCode || 500;
        const level = errorLogLevel(statusCode);
        // Keep diagnostics categorical; request values and exception prose can
        // contain credentials or user-controlled content.
        if (level === 'warn') {
            log({
                module: 'fastify-error',
                level,
                method,
                statusCode,
                errorCode: error.code,
            }, 'Request rejected');
        } else {
            log({
                module: 'fastify-error',
                level,
                method,
                statusCode,
                errorCode: error.code,
            }, 'Unhandled request error');
        }

        // Return appropriate error response
        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s. Skipped when caller will register
    // its own (e.g. SPA fallback for self-hosted webapp).
    if (!options.skipNotFoundHandler) {
        app.setNotFoundHandler((request, reply) => {
            log({ module: '404-handler', method: request.method }, 'Route not found');
            reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
        });
    }

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const statusCode = error.statusCode
            || (reply.statusCode >= 400 ? reply.statusCode : 500);
        const level = errorLogLevel(statusCode);

        if (level === 'warn') {
            log({
                module: 'fastify-hook-error',
                level,
                method,
                durationMs: Math.round(duration * 1000),
                statusCode,
                errorCode: error.code
            }, 'Request rejected');
        } else {
            log({
                module: 'fastify-hook-error',
                level,
                method,
                durationMs: Math.round(duration * 1000),
                statusCode,
                errorCode: error.code
            }, 'Unhandled request error');
        }
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                }, 'Response serialization failed');
                throw error;
            }
        };
    });
}
