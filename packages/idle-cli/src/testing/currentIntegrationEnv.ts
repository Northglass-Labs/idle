import type { IntegrationEnvironment } from './integrationEnvironment';

declare global {
    // eslint-disable-next-line no-var
    var __idleIntegrationEnv: IntegrationEnvironment | undefined;
}

export function getIntegrationEnv(): IntegrationEnvironment {
    if (!globalThis.__idleIntegrationEnv) {
        throw new Error('No active integration environment');
    }

    return globalThis.__idleIntegrationEnv;
}
