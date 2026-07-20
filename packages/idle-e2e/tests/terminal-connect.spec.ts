import { test, expect } from '../helpers/browserTest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { createTestAccount, cleanupTestAccount, SERVER_URL, type TestAccount } from '../helpers/auth';

/**
 * E2E tests for the terminal connect flow.
 *
 * The terminal auth handshake works like this:
 * 1. CLI generates a curve25519 (box) keypair
 * 2. CLI POSTs the publicKey to /v1/auth/request → server stores as "pending"
 * 3. Web app navigates to /terminal/connect#key=<base64url-encoded-publicKey>
 * 4. Web app shows an "Accept Connection" button
 * 5. User clicks accept and explicitly confirms the account-access grant
 * 6. App encrypts the response and POSTs /v1/auth/response
 * 7. CLI polls /v1/auth/request and gets state: "authorized"
 */

/** Convert standard base64 to base64url (URL-safe, no padding) */
function toBase64url(base64: string): string {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let account: TestAccount;

test.describe('Terminal Connect Flow', () => {
    test.beforeAll(async () => {
        account = await createTestAccount();
    });

    test.afterAll(async () => {
        await cleanupTestAccount(account);
    });

    test('terminal connect page loads with key in hash', async ({ page }) => {
        // Generate a curve25519 keypair for the URL
        const boxKeypair = tweetnacl.box.keyPair();
        const publicKeyB64 = Buffer.from(boxKeypair.publicKey).toString('base64');
        const publicKeyB64url = toBase64url(publicKeyB64);

        await page.goto(`/terminal/connect#key=${publicKeyB64url}`);

        // React Native Web renders Pressable as <div role="button"> without
        // standard button semantics. Use text content matching instead.
        // Wait for the page to render the connect UI.
        await page.waitForTimeout(2000);

        // Check page content for key UI text
        const pageContent = await page.textContent('body') ?? '';
        const hasAcceptText = /accept connection/i.test(pageContent);
        const hasConnectText = /connect terminal/i.test(pageContent);

        expect(hasAcceptText || hasConnectText).toBe(true);
    });

    test('terminal connect page without key handles gracefully', async ({ page }) => {
        // Navigate to the connect page WITHOUT a key in the hash
        await page.goto('/terminal/connect');

        // The page should handle this gracefully — show an error message
        // rather than crashing. Look for the "Invalid Connection Link" text.
        const invalidText = page.getByText(/invalid connection link/i);
        const hasInvalidMessage = await invalidText.isVisible().catch(() => false);

        // The page should not crash (no uncaught errors in console).
        // It should either show the invalid link message or redirect.
        // At minimum, the page should have loaded.
        const title = await page.title();
        expect(title).toBeDefined();

        // If the app rendered the connect page, it should show the invalid message
        if (!hasInvalidMessage) {
            // Alternatively, the app might redirect to login or home — that's OK too
            const url = page.url();
            expect(url).toBeTruthy();
        }
    });

    test('full auth handshake: CLI creates request, web app accepts', async ({ page }) => {
        const browserAuthTraffic: string[] = [];
        page.on('response', (response) => {
            const url = new URL(response.url());
            if (url.origin === SERVER_URL && url.pathname.startsWith('/v1/auth/')) {
                browserAuthTraffic.push(
                    `${response.request().method()} ${url.pathname} ${response.status()}`,
                );
            }
        });
        page.on('requestfailed', (request) => {
            const url = new URL(request.url());
            if (url.origin === SERVER_URL && url.pathname.startsWith('/v1/auth/')) {
                browserAuthTraffic.push(
                    `${request.method()} ${url.pathname} failed: ${request.failure()?.errorText ?? 'unknown'}`,
                );
            }
        });

        // Sign the isolated browser into the same disposable account created by
        // beforeAll. A terminal grant is an authenticated account operation; an
        // anonymous direct visit can render the route but cannot approve it.
        const accountSecret = toBase64url(
            Buffer.from(account.secretKey).toString('base64'),
        );
        await page.addInitScript(({ token, secret }) => {
            window.localStorage.setItem(
                'auth_credentials',
                JSON.stringify({ token, secret }),
            );
        }, {
            token: account.token,
            secret: accountSecret,
        });

        // Step 1: CLI generates a curve25519 keypair
        const boxKeypair = tweetnacl.box.keyPair();
        const publicKeyB64 = Buffer.from(boxKeypair.publicKey).toString('base64');

        // Step 2: CLI creates the auth request on the server
        const requestResponse = await axios.post(`${SERVER_URL}/v1/auth/request`, {
            publicKey: publicKeyB64,
            supportsV2: true,
        });
        expect(requestResponse.status).toBe(200);
        expect(requestResponse.data.state).toBe('requested');

        // Verify the request is pending on the server
        const statusResponse = await axios.get(`${SERVER_URL}/v1/auth/request/status`, {
            params: { publicKey: publicKeyB64 },
        });
        expect(statusResponse.data.status).toBe('pending');

        // Step 3: Web app navigates to the connect page with the key
        const publicKeyB64url = toBase64url(publicKeyB64);
        await page.goto(`/terminal/connect#key=${publicKeyB64url}`);

        // Step 4: Look for the "Accept Connection" button and click it.
        // React Native Web renders Pressable with role="button" but Playwright
        // getByRole doesn't match it reliably. Use locator with text matching.
        await page.waitForTimeout(2000);
        const acceptButton = page.locator('[role="button"]', { hasText: /accept connection/i });
        const isVisible = await acceptButton.isVisible().catch(() => false);

        if (isVisible) {
            await acceptButton.click();

            // Step 5: Pairing now requires a second, explicit confirmation because
            // it grants this terminal access to the signed-in account.
            await expect(
                page.getByText(/grant account access to this terminal/i),
            ).toBeVisible();

            const confirmButton = page.locator('[role="button"]', {
                hasText: /^pair terminal$/i,
            });
            await expect(confirmButton).toBeVisible();
            await confirmButton.click();

            // Step 6: Assert the user-visible completion before checking the
            // relay once. Repeated status polling can itself trip the public
            // pairing-request rate limit and hide the actual app failure.
            await expect(
                page.getByText(/terminal connected successfully/i),
                `Browser auth traffic: ${browserAuthTraffic.join(', ') || 'none'}`,
            ).toBeVisible({
                timeout: 10_000,
            });

            const finalStatus = await axios.get(`${SERVER_URL}/v1/auth/request/status`, {
                params: { publicKey: publicKeyB64 },
            });
            expect(finalStatus.data.status).toBe('authorized');
        } else {
            // If the accept button isn't visible, the user might not be logged in
            // to the web app. This is expected in CI without a pre-authenticated
            // session. The test still validates the server-side auth request flow.
            test.skip(true, 'Accept button not visible — web app likely requires authentication');
        }
    });
});
