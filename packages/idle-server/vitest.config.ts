import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Local route-security specs run in the ordinary suite. Only explicitly named
// `*.live.security.spec.ts` deployed-server smoke tests stay separate.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.security.spec.ts'],
  },
  plugins: [tsconfigPaths()]
});
