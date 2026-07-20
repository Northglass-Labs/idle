import { afterAll } from 'vitest';
import {
    applyEnvironmentToProcess,
    createIntegrationEnvironment,
    destroyIntegrationEnvironment,
    type EnvironmentTemplate,
    type IntegrationEnvironment,
} from './integrationEnvironment';

type IntegrationEnvironmentProfile = {
    template: EnvironmentTemplate;
    up: boolean;
};

declare global {
    // eslint-disable-next-line no-var
    var __idleIntegrationEnv: IntegrationEnvironment | undefined;
}

export async function installIntegrationEnvironment(profile: IntegrationEnvironmentProfile) {
    const previousEnv = {
        IDLE_SERVER_URL: process.env.IDLE_SERVER_URL,
        IDLE_WEBAPP_URL: process.env.IDLE_WEBAPP_URL,
        IDLE_HOME_DIR: process.env.IDLE_HOME_DIR,
        IDLE_PROJECT_DIR: process.env.IDLE_PROJECT_DIR,
        IDLE_VARIANT: process.env.IDLE_VARIANT,
        DEBUG: process.env.DEBUG,
    };

    const env = await createIntegrationEnvironment(profile);
    applyEnvironmentToProcess(env);
    globalThis.__idleIntegrationEnv = env;

    afterAll(async () => {
        try {
            await destroyIntegrationEnvironment(env);
        } finally {
            for (const [key, value] of Object.entries(previousEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }

            if (globalThis.__idleIntegrationEnv?.name === env.name) {
                globalThis.__idleIntegrationEnv = undefined;
            }
        }
    });
}
