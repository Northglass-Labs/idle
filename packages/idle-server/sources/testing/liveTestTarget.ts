export const LIVE_TEST_ALLOW_FLAG = 'IDLE_ALLOW_LIVE_TESTS';
export const LIVE_TEST_URL_VARIABLE = 'TEST_SERVER_URL';

export function getExplicitLiveTestTarget(env: NodeJS.ProcessEnv = process.env): string | null {
    const rawUrl = env[LIVE_TEST_URL_VARIABLE]?.trim();
    const allowed = env[LIVE_TEST_ALLOW_FLAG] === '1';
    if (!rawUrl || !allowed) return null;

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`${LIVE_TEST_URL_VARIABLE} must be an absolute HTTP(S) URL`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`${LIVE_TEST_URL_VARIABLE} must use HTTP or HTTPS`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
        throw new Error(`${LIVE_TEST_URL_VARIABLE} must be a credential-free server origin`);
    }
    return parsed.origin;
}
