import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Deployed-server smoke tests are skipped unless TEST_SERVER_URL and
// IDLE_ALLOW_LIVE_TESTS=1 are both explicitly provided.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['sources/**/*.live.security.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  plugins: [tsconfigPaths()]
});
