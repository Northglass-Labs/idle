export const LIVE_AGENT_INTEGRATION_ENV = 'IDLE_RUN_LIVE_AGENT_INTEGRATION';

type Environment = Readonly<Record<string, string | undefined>>;

/** Live provider tests may create billable activity or remote account state. */
export function shouldRunLiveAgentIntegration(
    environment: Environment = process.env,
): boolean {
    return environment[LIVE_AGENT_INTEGRATION_ENV] === '1';
}
