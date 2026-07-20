import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { canCredentialUseHttp } from "@/app/auth/credentialPurpose";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            log({
                module: 'auth-decorator',
                method: request.method,
                hasAuthorizationHeader: Boolean(authHeader),
            }, 'Authentication check');
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, 'Authentication failed: invalid header');
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified || !canCredentialUseHttp(verified.extras)) {
                log({ module: 'auth-decorator' }, 'Authentication failed: invalid token');
                return reply.code(401).send({ error: 'Invalid token' });
            }

            log({ module: 'auth-decorator' }, 'Auth success');
            request.userId = verified.userId;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
