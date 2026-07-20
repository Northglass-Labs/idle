import { type Fastify } from './types';
import { adminRoutes } from './routes/adminRoutes';

/**
 * Registers Idle-owned API modules that are isolated from the core relay
 * surface. Each module must retain its own authentication and fail-closed
 * configuration checks before it is added here.
 */
export function registerIdleRoutes(app: Fastify) {
    // The operator surface is disabled unless a strong admin secret is
    // configured, so route registration does not weaken the default runtime.
    adminRoutes(app);
}
