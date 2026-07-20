/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * Workspace test scripts build the CLI before Vitest starts. Building inside
 * global setup is unsafe: concurrent Vitest processes each remove and recreate
 * dist/, so one test run can lose its entrypoint while another is rebuilding.
 * Integration suites provision their own isolated environments.
 */

export async function setup() {
    // --- Never let a test touch the PRODUCTION relay ---
    // Idle's tests make real API calls (no mocking). Any test that resolves the
    // server URL to the hardcoded prod default (idle-api.northglass.io) silently
    // creates a real account on prod — this is how 90+ stale test accounts
    // accumulated. Integration suites isolate themselves via
    // createIntegrationEnvironment() (localhost); everything else must not fall
    // through to prod. So: hard-fail if a non-local relay is explicitly set, and
    // force a dead-local default so any un-isolated real call fails loudly
    // (ECONNREFUSED) instead of quietly minting a prod account.
    const isLocal = (u: string | undefined) => {
        if (!u) return false
        try {
            const h = new URL(u).hostname
            return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')
        } catch {
            return false
        }
    }
    for (const key of ['IDLE_SERVER_URL']) {
        const v = process.env[key]
        if (v && !isLocal(v)) {
            throw new Error(
                `[test-guard] ${key}=${v} points at a non-local relay. Tests must never hit ` +
                `idle-api.northglass.io — use createIntegrationEnvironment() or a localhost server.`
            )
        }
        if (!v) {
            process.env[key] = 'http://127.0.0.1:1'
        }
    }

    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.IDLE_RUN_SANDBOX_NETWORK_TESTS = '1'
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
}
