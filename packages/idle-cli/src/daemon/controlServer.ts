/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData } from './types';
import {
  LoopbackSpawnSessionRequestSchema,
  SpawnSessionOptions,
  SpawnSessionResult,
} from './spawnSessionOptions';
import { timingSafeEqual } from 'node:crypto';

const ControlSessionIdSchema = z.string().min(1).max(128);
const ControlVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ControlEncryptionKeySchema = z.string().min(1).max(512).base64().refine((value) => {
  try {
    return decodeBase64(value).length === 32;
  } catch {
    return false;
  }
});

function hasValidBearerToken(header: string | undefined, authToken: string): boolean {
  const presented = Buffer.from(header ?? '', 'utf8');
  const expected = Buffer.from(`Bearer ${authToken}`, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function startDaemonControlServer({
  authToken,
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onIdleSessionWebhook
}: {
  authToken: string;
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean | Promise<boolean>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onIdleSessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  if (authToken.length < 32 || authToken.length > 256) {
    return Promise.reject(new Error('Invalid daemon control token'));
  }

  return new Promise((resolve, reject) => {
    const app = fastify({
      logger: false, // We use our own logger
      bodyLimit: 1024 * 1024,
      connectionTimeout: 10_000,
      requestTimeout: 15_000,
      keepAliveTimeout: 1_000,
      maxRequestsPerSocket: 16,
    });

    app.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!hasValidBearerToken(request.headers.authorization, authToken)) {
        return reply.code(401).type('text/plain').send('unauthorized');
      }
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: ControlSessionIdSchema,
          metadata: z.any(),
          encryption: z.object({
            encryptionKey: ControlEncryptionKeySchema,
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: ControlVersionSchema,
            metadataVersion: ControlVersionSchema,
            agentStateVersion: ControlVersionSchema,
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

      logger.debug('[CONTROL SERVER] Session-start notification received');

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onIdleSessionWebhook(sessionId, metadata, encryptionData);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            daemonPid: z.number().int().positive(),
            children: z.array(z.object({
              startedBy: z.string(),
              idleSessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return {
        daemonPid: process.pid,
        children: children
          .filter(child => child.idleSessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            idleSessionId: child.idleSessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: ControlSessionIdSchema,
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug('[CONTROL SERVER] Stop-session request received');
      const success = await stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: LoopbackSpawnSessionRequestSchema,
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn-session request received for agent=${agent || 'default'}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };

        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return {
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };

        case 'requestToApproveCodexNativeSandbox':
          reply.code(409);
          return {
            success: false,
            requiresUserApproval: true,
            actionRequired: 'USE_CODEX_NATIVE_SANDBOX'
          };

        case 'error':
          reply.code(500);
          return {
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.literal('stopping'),
            daemonPid: z.number().int().positive(),
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' as const, daemonPid: process.pid };
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start');
        reject(err);
        return;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug('[CONTROL SERVER] Started');

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
