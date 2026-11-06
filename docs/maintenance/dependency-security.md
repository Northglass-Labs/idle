# Dependency security maintenance

The release graph maintains explicit security floors for packages used by the self-hosted relay, web app and build toolchain.

## Changes

- Raised Engine.IO to 6.6.10 or newer so a WebSocket upgrade cannot switch an existing Engine.IO v4 session to a mismatched protocol parser and crash the process (`GHSA-2gc4-cqfq-p2gv`).
- Raised `socket.io-parser` to 4.2.7 or newer so zero-attachment binary packets are rejected instead of retaining an unbounded reconstructor (`GHSA-2m8v-j782-fhvr`).
- Raised `@fastify/static` to 10.1.1 or newer to preserve route guards across dot-segment paths (`GHSA-83w8-p2f5-377r`).
- Refreshed Fastify, Axios, `fast-uri`, Sharp, `tar`, PostCSS, Nano ID, JS-YAML, `find-my-way`, and brace-expansion lock entries to their patched releases.
- Moved the digest-pinned Node 22 runtime to Alpine and added only OpenSSL to the base runtime image, eliminating the unfixed high-severity operating-system findings in the previous Debian runtime.
- Upgraded Alpine packages in the final unprivileged Nginx stage so fixed runtime libraries published after the digest-pinned base was built are included in each verified release image.
- Added compatible resolutions for patched XML, browser-data, image-size, Hono, Mermaid, selector-parser, URI-decoding, and Prisma configuration dependencies.
- Raised the shipped CLI and relay graph to `body-parser` 2.4, `proxy-addr` 2.0.8, `shell-quote` 1.11 or newer, and Model Context Protocol SDK 1.32.0. MCP tool input is also bounded to the one declared title argument.
- Added a fail-closed package transform for the exact reviewed `@anthropic-ai/sandbox-runtime` 0.0.37, `privacy-kit` 0.0.25, `query-string` 7.1.3, and `@prisma/config` 6.19.3 releases. It verifies upstream versions and file hashes before changing bytes, migrates both original and previously transformed Zod imports to native Zod 4, preserves sandbox declaration compatibility with a reviewed local type shim, and installs fixed URI-decoder and deep-merge releases. Previously transformed `/v3` bytes are accepted only as exact migration inputs; every packed runtime and declaration must end at `/v4`. The transformed runtime dependencies are bundled into the CLI and relay tarballs so an ordinary npm consumer receives the reviewed graph without relying on root-only Yarn resolutions.
- Kept the patched `image-size` 2.x API and added a version-bound Metro transform for Expo SDK 55: Metro now reads ordinary asset paths into bytes before calling the parser. The transform recognizes only the reviewed Metro 0.83.5/0.83.7 source anchor, is idempotent, and fails the install on version or source drift.
- Updated the native Mermaid WebView's exact CDN, CSP and SRI pin from vulnerable 11.16.0 to reviewed 11.17.2; the fetched artifact is byte-identical to the locked package bundle.
- Added a regression test that exercises the Engine.IO protocol-mismatch rejection and Socket.IO zero-attachment rejection against the installed release graph.

## Verification

- The dependency regression and repository dependency-boundary tests pass.
- Prisma Client generation passes with the resolved Prisma configuration graph.
- The CLI's 150 unit-test files (1,288 tests) and typecheck pass. The real sandbox-runtime integration preserves argument boundaries and denies configured reads, egress, and local binding.
- The relay's 83 Vitest files (700 tests), package/runtime/migration contracts (36 tests), typecheck, and standalone runtime build pass.
- Normal-lifecycle CLI and relay tarballs install in an otherwise empty npm consumer. Their reviewed JavaScript, CommonJS, ESM, and declaration representations reject `/v3` imports; a strict consumer typecheck runs with `skipLibCheck` disabled, and a 5,000-element invalid input to a maximum-100 array produces only the top-level `too_big` issue. The production audit reports zero critical and zero high findings; its four remaining moderate aggregate nodes are the CLI, relay, MinIO, and `stream-json` chain.
- A clean staged prefix serves the packaged relay on loopback, completes a Prisma-backed authentication-status read, and shuts down cleanly. CLI help, version, doctor, and daemon-status commands work with an isolated Idle home.
- A Node 22 production Expo export passes with the patched `image-size` release, and its 331 generated JavaScript bundles pass the release verifier.
- A production relay image and its installed runtime dependency graph are scanned before deployment; the final scan receipt and deployment acceptance evidence are retained outside the public repository.

`yarn audit --groups dependencies` reports no critical vulnerabilities. Its remaining 14 high-severity resolution paths are confined to the Expo mobile workspace (`compression`, `node-forge`, and Expo CLI's Zod 3); they are not present in the packed CLI/relay consumer graph. They remain a separate mobile-toolchain maintenance item and must not be represented as a clean whole-monorepo audit.
