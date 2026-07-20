import { normalizeServerUrl } from '@northglass/idle-wire';

export function loadAuthAudience(environment: NodeJS.ProcessEnv = process.env): string {
    const configured = environment.IDLE_AUTH_AUDIENCE;
    if (!configured) {
        throw new Error('IDLE_AUTH_AUDIENCE is required before authentication routes can start');
    }

    try {
        return normalizeServerUrl(configured);
    } catch {
        throw new Error('IDLE_AUTH_AUDIENCE must be a canonical HTTPS relay origin or a loopback HTTP origin');
    }
}
