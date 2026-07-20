import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    // React Native / Expo modules expect the bundler-injected __DEV__ global.
    define: { __DEV__: 'false' },
    test: {
        globals: false,
        environment: 'node',
        // Native bridge adapters are tested with explicit boundary mocks;
        // cryptographic behavior runs against real libsodium and Web Crypto.
        include: ['sources/**/*.{spec,test}.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        alias: [
            {
                find: /^@expo\/vector-icons\/(?:FontAwesome|Ionicons|MaterialCommunityIcons|Octicons)$/,
                replacement: resolve('./vitest.vector-icon-mock.ts'),
            },
            {
                find: '@',
                replacement: resolve('./sources'),
            },
            // vitest 4 (rolldown) cannot parse react-native's Flow-typed dist, and
            // several sync-layer modules now transitively reach it (mmkv, vector
            // icons, posthog). Node-mode tests get the web implementation instead,
            // exactly like the Expo web bundle does.
            {
                find: 'react-native',
                replacement: 'react-native-web',
            },
        ],
    },
})
