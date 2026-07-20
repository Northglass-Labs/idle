const URL_VARIABLE = 'TEST_SERVER_URL';
const ALLOW_VARIABLE = 'IDLE_ALLOW_LIVE_TESTS';

function requireExplicitLiveTestTarget(env: NodeJS.ProcessEnv = process.env): string {
    const rawUrl = env[URL_VARIABLE]?.trim();
    if (!rawUrl || env[ALLOW_VARIABLE] !== '1') {
        throw new Error(
            `Idle E2E network tests require both ${URL_VARIABLE} and ${ALLOW_VARIABLE}=1`,
        );
    }

    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || !['', '/'].includes(parsed.pathname)) {
        throw new Error(`${URL_VARIABLE} must be a credential-free HTTP(S) server origin`);
    }
    return parsed.origin;
}

export const SERVER_URL = requireExplicitLiveTestTarget();
