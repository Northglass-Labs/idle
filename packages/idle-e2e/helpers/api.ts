import axios, { type AxiosInstance } from 'axios';
import { createTestAccount, cleanupTestAccount, type TestAccount } from './auth';
import { SERVER_URL } from './liveTarget';

/**
 * Create an authenticated axios instance for API testing.
 *
 * Uses createTestAccount() to get a valid JWT, then returns an axios client
 * with the Authorization header pre-configured. Also returns the account
 * for cleanup after tests.
 */
export async function createAuthenticatedClient(): Promise<{
    client: AxiosInstance;
    account: TestAccount;
}> {
    const account = await createTestAccount();
    const client = axios.create({
        baseURL: SERVER_URL,
        headers: { Authorization: `Bearer ${account.token}` },
        timeout: 30000,
    });

    return { client, account };
}

/**
 * Create an authenticated client and return a cleanup function for use in
 * test setup/teardown.
 *
 * Example:
 *   let api: Awaited<ReturnType<typeof createTestApi>>;
 *   test.beforeEach(async () => { api = await createTestApi(); });
 *   test.afterEach(async () => { await api.cleanup(); });
 */
export async function createTestApi() {
    const { client, account } = await createAuthenticatedClient();

    return {
        client,
        account,
        cleanup: () => cleanupTestAccount(account),
    };
}

// Re-export auth types for convenience
export type { TestAccount } from './auth';
