import { z } from "zod";
import { type Fastify } from "../types";
import { githubDisconnect } from "@/app/github/githubDisconnect";
import { Context } from "@/context";
import { FreeTextSchema } from "@/app/api/routes/_schemas";

export function connectRoutes(app: Fastify) {
    // GitHub disconnect endpoint
    app.delete('/v1/connect/github', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: FreeTextSchema
                }),
                500: z.object({
                    error: FreeTextSchema
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const ctx = Context.create(userId);
        try {
            await githubDisconnect(ctx);
            return reply.send({ success: true });
        } catch (error: any) {
            return reply.code(500).send({ error: 'Failed to disconnect GitHub account' });
        }
    });

}
