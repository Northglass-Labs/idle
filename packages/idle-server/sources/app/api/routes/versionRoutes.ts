import { z } from "zod";
import { type Fastify } from "../types";
import { NameSchema } from "@/app/api/routes/_schemas";

export function versionRoutes(app: Fastify) {
    app.post('/v1/version', {
        schema: {
            body: z.object({
                platform: NameSchema,
                version: NameSchema,
                app_id: NameSchema
            }),
            response: {
                200: z.object({
                    updateUrl: z.null()
                })
            }
        }
    }, async (_request, reply) => {
        // TestFlight and internal builds receive updates from their distribution
        // channel. Do not advertise a store URL until Idle has a live public
        // listing that Northglass can verify and support.
        reply.send({ updateUrl: null });
    });
}
