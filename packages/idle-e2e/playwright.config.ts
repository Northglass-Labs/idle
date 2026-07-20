import { defineConfig, devices } from '@playwright/test';
import { SERVER_URL } from './helpers/liveTarget';

// Importing the explicit target guard makes accidental ordinary E2E runs fail
// before any browser or API traffic starts.
void SERVER_URL;

export default defineConfig({
    testDir: './tests',
    timeout: 60000,
    retries: 1,
    reporter: 'html',
    use: {
        baseURL: 'http://localhost:8081',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'Mobile Safari',
            use: { ...devices['iPhone 14'] },
        },
    ],
});
