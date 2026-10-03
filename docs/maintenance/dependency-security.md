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
- Kept the patched `image-size` 2.x API and added a version-bound Metro transform for Expo SDK 55: Metro now reads ordinary asset paths into bytes before calling the parser. The transform recognizes only the reviewed Metro 0.83.5/0.83.7 source anchor, is idempotent, and fails the install on version or source drift.
- Updated the native Mermaid WebView's exact CDN, CSP and SRI pin from vulnerable 11.16.0 to reviewed 11.17.2; the fetched artifact is byte-identical to the locked package bundle.
- Added a regression test that exercises the Engine.IO protocol-mismatch rejection and Socket.IO zero-attachment rejection against the installed release graph.

## Verification

- The dependency regression and repository dependency-boundary tests pass.
- Prisma Client generation passes with the resolved Prisma configuration graph.
- The relay's 83 Vitest files (700 tests), eight package and migration contract suites (28 tests), typecheck, and standalone runtime build pass.
- A Node 22 production Expo export passes with the patched `image-size` release, and its 331 generated JavaScript bundles pass the release verifier.
- A production relay image and its installed runtime dependency graph are scanned before deployment; the final scan receipt and deployment acceptance evidence are retained outside the public repository.

`yarn audit --groups dependencies` reports no critical vulnerabilities. Its remaining high-severity entries are limited to advisories for `braces` and `node-forge` for which the registry reports no patched release. Those packages are build/mobile tooling and are excluded from the production relay image; they will be revisited when upstream publishes a fixed version.
